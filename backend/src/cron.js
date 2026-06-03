// ─── Reorder Cron Scheduler ───
// Runs daily to check for patients whose "Days to Order" column = "20 Days".
// The cron itself is lightweight — it discovers eligible patients and enqueues
// each one as a BullMQ job. The worker handles token generation, Monday writes,
// and SMS sending with built-in rate limiting so the Express server stays responsive.

const cron = require("node-cron");
const {
  getPatientsAt20DaysOut,
} = require("./monday");
const { enqueueReorderPatient, checkBatchComplete } = require("./queue");
const { notifyCronError, notifyCronSummary } = require("./notify");
const { redis } = require("./redis");

const PRODUCTION_SMS_ENABLED = process.env.PRODUCTION_SMS_ENABLED === "true";

// ─── Main cron job — discover and enqueue ───

async function checkAndProcessReorders() {
  console.log(`[cron] ═══ Reorder check started at ${new Date().toISOString()} ═══`);
  console.log(`[cron] Production SMS: ${PRODUCTION_SMS_ENABLED ? "ON — all patients" : "OFF — [TEST] patients only"}`);

  try {
    const patients = await getPatientsAt20DaysOut();
    console.log(`[cron] Found ${patients.length} patient(s) with Days to Order = "20 Days"`);

    // Filter out patients who already received the text
    const eligible = patients.filter((p) => {
      if (p.reorderTextSent) {
        console.log(`[cron] Skipping UID ${p.uid} (${p.name}) — already sent on ${p.reorderTextSent}`);
        return false;
      }
      return true;
    });

    // Filter for production gate
    const toProcess = eligible.filter((p) => {
      if (!p.uid) {
        console.warn(`[cron] Skipping item ${p.itemId} (${p.name}) — no UID`);
        return false;
      }
      const isTestPatient = p.name && p.name.includes("[TEST]");
      if (!PRODUCTION_SMS_ENABLED && !isTestPatient) {
        console.log(`[cron] Skipping UID ${p.uid} (${p.name}) — production SMS off, not a [TEST] patient`);
        return false;
      }
      if (!p.phone) {
        console.warn(`[cron] Skipping UID ${p.uid} (${p.name}) — no phone number`);
        notifyCronError(`Patient "${p.name}" has no phone number — cannot send reorder text`, p.uid).catch(() => {});
        return false;
      }
      return true;
    });

    console.log(`[cron] ${toProcess.length} patient(s) eligible for reorder text (${eligible.length - toProcess.length} skipped)`);

    if (toProcess.length === 0) {
      console.log(`[cron] Nothing to process`);
      await notifyCronSummary(0, 0, patients.length - toProcess.length);
      return { processed: 0, enqueued: 0, skipped: patients.length };
    }

    // Generate a batch ID so the verification job can find all messages from this run
    const batchId = `cron-${Date.now()}`;

    // Enqueue each patient as a BullMQ job — worker handles the heavy lifting
    let enqueued = 0;
    for (const patient of toProcess) {
      try {
        await enqueueReorderPatient(patient, batchId);
        enqueued++;
      } catch (err) {
        console.error(`[cron] Failed to enqueue UID ${patient.uid} (${patient.name}): ${err.message}`);
        await notifyCronError(`Failed to enqueue "${patient.name}": ${err.message}`, patient.uid).catch(() => {});
      }
    }

    // Set expected count AFTER all enqueuing so checkBatchComplete knows when all jobs are done.
    // If some failed to enqueue, expected = enqueued (not toProcess.length).
    if (enqueued > 0) {
      await redis.set(`sms-verify:${batchId}:expected`, enqueued, "EX", 7200);
      // In case all jobs already completed before we set expected
      await checkBatchComplete(batchId).catch(err =>
        console.error(`[cron] Post-enqueue batch check error: ${err.message}`)
      );
    }

    console.log(`[cron] ═══ Reorder check complete: ${enqueued}/${toProcess.length} enqueued, worker will process with rate limiting ═══`);
    await notifyCronSummary(enqueued, toProcess.length - enqueued, patients.length - toProcess.length);

    return { enqueued, total: toProcess.length, skipped: patients.length - toProcess.length, batchId };
  } catch (err) {
    console.error(`[cron] Fatal error in reorder check:`, err.message, err.stack);
    await notifyCronError(`Fatal cron error: ${err.message}\n${err.stack || ""}`);
    return { error: err.message };
  }
}

// ─── Leader lock — prevents duplicate cron runs across Railway replicas ───

const CRON_LOCK_KEY = "cron:reorder-check:lock";
const CRON_LOCK_TTL = 1800; // 30 min — longer than any cron run should take

async function acquireCronLock() {
  const instanceId = `${process.env.RAILWAY_REPLICA_ID || process.pid}-${Date.now()}`;
  const result = await redis.set(CRON_LOCK_KEY, instanceId, "EX", CRON_LOCK_TTL, "NX");
  if (result === "OK") {
    console.log(`[cron] Leader lock acquired (instance: ${instanceId})`);
    return instanceId;
  }
  const holder = await redis.get(CRON_LOCK_KEY);
  console.log(`[cron] Another instance holds the cron lock (holder: ${holder}) — skipping`);
  return null;
}

async function releaseCronLock(instanceId) {
  // Atomic check-and-delete via Lua — prevents race where TTL expires,
  // another replica acquires the lock, and our DEL wipes their lock.
  const released = await redis.eval(
    `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
    1, CRON_LOCK_KEY, instanceId
  );
  if (released === 1) {
    console.log(`[cron] Leader lock released`);
  }
}

// ─── Schedule: runs once daily at 1:30 PM ET ───

function startCron() {
  const schedule = "30 13 * * *";

  const task = cron.schedule(schedule, async () => {
    // Leader election — only one replica runs the cron
    const lockId = await acquireCronLock().catch(() => null);
    if (!lockId) return;

    try {
      await checkAndProcessReorders();
    } catch (err) {
      console.error("[cron] Unhandled error:", err);
      notifyCronError(`Unhandled cron error: ${err.message}`);
    } finally {
      await releaseCronLock(lockId).catch(() => {});
    }
  }, {
    timezone: "America/New_York",
  });

  console.log(`[cron] Reorder scheduler started — runs daily at 1:30 PM ET (replica-safe)`);

  return task;
}

module.exports = {
  startCron,
  checkAndProcessReorders,
};
