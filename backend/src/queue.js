const { Queue, Worker } = require("bullmq");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

function parseRedisUrl(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: parseInt(u.port, 10) || 6379,
      password: u.password || undefined,
      username: u.username || undefined,
      tls: u.protocol === "rediss:" ? {} : undefined,
    };
  } catch {
    return { host: "localhost", port: 6379 };
  }
}

const connection = parseRedisUrl(REDIS_URL);

// ─── Monday Write Queue ───
// All Monday.com mutations go through this queue for:
// - Automatic retry with exponential backoff
// - Concurrency limiting (stay under Monday rate limits)
// - Dead letter queue for failed writes after all retries

const mondayWriteQueue = new Queue("reorder-monday-writes", {
  connection,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

let _worker = null;
let _workerReady = false;

function startWorker(mondayQuery) {
  _worker = new Worker(
    "reorder-monday-writes",
    async (job) => {
      const { query, variables, label } = job.data;
      console.log(`[queue] Processing write: ${label} (attempt ${job.attemptsMade + 1}/${job.opts.attempts})`);
      try {
        await mondayQuery(query, variables);
        return { success: true, label };
      } catch (err) {
        console.error(`[queue] Write failed: ${label} — ${err.message}`);
        throw err;
      }
    },
    {
      connection,
      concurrency: 3,
      limiter: {
        max: 10,
        duration: 10_000,
      },
    }
  );

  _worker.on("ready", () => {
    _workerReady = true;
    console.log("[queue] Monday write worker ready");
  });

  _worker.on("completed", (job, result) => {
    console.log(`[queue] Completed: ${result.label}`);
  });

  _worker.on("failed", (job, err) => {
    if (job.attemptsMade >= job.opts.attempts) {
      console.error(`[queue] DEAD LETTER — ${job.data.label} failed after ${job.attemptsMade} attempts: ${err.message}`);
    }
  });

  _worker.on("error", (err) => {
    console.error("[queue] Worker error:", err.message);
  });

  return _worker;
}

async function enqueueWrite(query, variables, label = "write") {
  const job = await mondayWriteQueue.add("monday-write", { query, variables, label });
  return job.id;
}

async function enqueueWriteAndWait(query, variables, label = "write", timeoutMs = 15000) {
  const job = await mondayWriteQueue.add("monday-write", { query, variables, label });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await job.getState();
    if (state === "completed") return { success: true };
    if (state === "failed") throw new Error(`Write failed: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { success: true, queued: true, message: "Write is processing in background" };
}

// ─── Reorder Patient Processing Queue ───
// Each patient from the cron is processed as a BullMQ job instead of a blocking loop.
// Rate-limited to stay under RingCentral's 40 SMS/min per number.
// The Express server stays responsive while patients are being processed.

const reorderQueue = new Queue("reorder-patient-process", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  },
});

let _reorderWorker = null;

function startReorderWorker() {
  const { generateReorderToken } = require("./auth");
  const { storeTokenInMonday, markReorderTextSent, getPatientOrderDetails } = require("./monday");
  const { sendSMS, buildReorderText } = require("./sms");
  const { enqueueSmsBatchVerification } = require("./queue");
  const { notifyCronError, notifyCronSummary } = require("./notify");
  const { redis } = require("./redis");

  const REORDER_URL = process.env.REORDER_URL || "https://reorder.medicallymodern.com";

  _reorderWorker = new Worker(
    "reorder-patient-process",
    async (job) => {
      const { patient, batchId } = job.data;
      const { itemId, name, uid, phone, nextOrder } = patient;
      console.log(`[reorder-queue] Processing item ${itemId} / UID ${uid} (${name}) — attempt ${job.attemptsMade + 1}/${job.opts.attempts}`);

      // 1. Generate reorder token (bound to this specific order row)
      const token = await generateReorderToken(uid, itemId);
      const link = `${REORDER_URL}?token=${token}`;

      // 2. Store in Monday — write to this exact row, not "first row for UID"
      await storeTokenInMonday(itemId, token, link);

      // 3. Fetch product details for SMS template (from this exact row)
      const details = await getPatientOrderDetails(itemId);

      // 4. Send SMS
      const messageText = buildReorderText(name, nextOrder || "TBD", link, {
        sensorsType: details?.sensorsType || null,
        suppliesType: details?.suppliesType || null,
        infusionSet1: details?.infusionSet1 || null,
        infusionSet2: details?.infusionSet2 || null,
      });
      const smsResult = await sendSMS(phone, messageText, { patientName: name });

      // 5. Mark as sent in Monday
      const sentTimestamp = new Date().toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      }) + " ET";
      await markReorderTextSent(itemId, sentTimestamp);

      // 6. Store result for batch verification
      const result = {
        uid,
        name,
        phone,
        messageId: smsResult.messageId || null,
        simulated: smsResult.simulated || false,
        originalMessage: messageText,
      };

      // Track in Redis for batch verification pickup
      if (result.messageId && !result.simulated) {
        await redis.rpush(`sms-verify:${batchId}`, JSON.stringify(result));
        await redis.expire(`sms-verify:${batchId}`, 3600); // 1hr TTL
      }

      console.log(`[reorder-queue] UID ${uid} (${name}) — done, messageId: ${smsResult.messageId || "simulated"}`);
      return result;
    },
    {
      connection,
      concurrency: 2,
      limiter: {
        max: 30,         // 30 jobs per 60s — comfortably under RC's 40/min
        duration: 60_000,
      },
    }
  );

  _reorderWorker.on("completed", async (job, result) => {
    console.log(`[reorder-queue] Completed: ${result.name} (${result.uid})`);
    try {
      await checkBatchComplete(job.data.batchId);
    } catch (err) {
      console.error(`[reorder-queue] Batch completion check error: ${err.message}`);
    }
  });

  _reorderWorker.on("failed", async (job, err) => {
    const patient = job.data.patient;
    if (job.attemptsMade >= job.opts.attempts) {
      console.error(`[reorder-queue] DEAD LETTER — ${patient.name} (${patient.uid}) failed after ${job.attemptsMade} attempts: ${err.message}`);
      notifyCronError(`Reorder processing failed for "${patient.name}" after all retries: ${err.message}`, patient.uid).catch(() => {});
      // Count final failures toward batch completion so verification still fires
      try {
        await checkBatchComplete(job.data.batchId);
      } catch (checkErr) {
        console.error(`[reorder-queue] Batch completion check error: ${checkErr.message}`);
      }
    }
  });

  _reorderWorker.on("error", (err) => {
    console.error("[reorder-queue] Worker error:", err.message);
  });

  console.log("[reorder-queue] Reorder patient processing worker ready (30/min rate limit)");
}

// ─── Batch completion tracking ───
// Replaces the broken "drained" event. Each job completion (success or final failure)
// atomically increments a counter. When counter == expected (set by cron after enqueuing),
// the batch is claimed via NX and verification is enqueued exactly once.
// No redis.keys() — uses deterministic keys keyed by batchId.

// `countCompletion: false` is for the cron's post-enqueue check: it must only READ the
// counter. Counting it as a completion (as it did until 2026-11-02) declared every batch done
// one job early, so the last patient's SMS was never delivery-verified or retried.
async function checkBatchComplete(batchId, { countCompletion = true } = {}) {
  if (!batchId) return;
  const { redis } = require("./redis");

  let completedCount;
  if (countCompletion) {
    completedCount = await redis.incr(`sms-verify:${batchId}:completed`);
    await redis.expire(`sms-verify:${batchId}:completed`, 7200);
  } else {
    completedCount = parseInt((await redis.get(`sms-verify:${batchId}:completed`)) || "0", 10);
  }

  const expectedStr = await redis.get(`sms-verify:${batchId}:expected`);
  if (!expectedStr) return; // Cron hasn't finished enqueuing yet — next completion will re-check

  if (completedCount < parseInt(expectedStr, 10)) return; // Not all jobs done yet

  // All jobs in this batch are done — atomically claim to prevent duplicate verification
  const claimed = await redis.set(`sms-verify:${batchId}:claimed`, "1", "EX", 7200, "NX");
  if (claimed !== "OK") return; // Another replica already claimed it

  const items = await redis.lrange(`sms-verify:${batchId}`, 0, -1);
  // Cleanup tracking keys (leave claimed key to prevent re-trigger)
  await redis.del(
    `sms-verify:${batchId}`,
    `sms-verify:${batchId}:expected`,
    `sms-verify:${batchId}:completed`
  );

  if (items.length > 0) {
    const sentMessages = items.map(i => JSON.parse(i));
    await enqueueSmsBatchVerification(sentMessages);
    console.log(`[reorder-queue] Batch ${batchId} — all ${completedCount} jobs done, ${sentMessages.length} message(s) queued for delivery verification`);
  } else {
    console.log(`[reorder-queue] Batch ${batchId} — all ${completedCount} jobs done, no messages to verify (all simulated or failed)`);
  }
}

async function enqueueReorderPatient(patient, batchId) {
  const job = await reorderQueue.add(
    `reorder-${patient.itemId}`,
    { patient, batchId },
    { jobId: `reorder-${patient.itemId}-${batchId}` } // Dedup by order row (itemId) + batch
  );
  return job.id;
}

// ─── Confirmation SMS Queue ───
// Replaces in-process setTimeout — persisted in Redis, survives restarts, auto-retries

const smsQueue = new Queue("reorder-confirmation-sms", {
  connection,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});

let _smsWorker = null;

function startSmsWorker() {
  // Lazy-require to avoid circular deps — these are only needed inside the worker
  const { getPatientOrderDetails } = require("./monday");
  const { sendSMS, buildConfirmationText } = require("./sms");
  const { notifySmsError } = require("./notify");

  _smsWorker = new Worker(
    "reorder-confirmation-sms",
    async (job) => {
      const { itemId, optOuts = {} } = job.data;
      console.log(`[sms-queue] Processing confirmation SMS for item ${itemId} (attempt ${job.attemptsMade + 1}/${job.opts.attempts})`);

      const details = await getPatientOrderDetails(itemId);
      if (!details) throw new Error(`Patient row ${itemId} not found in Monday`);
      if (!details.phone) throw new Error(`No phone for item ${itemId}`);

      const messageText = buildConfirmationText({
        name: details.name,
        address: details.address,
        nextOrder: details.nextOrder,
        sensorsType: details.sensorsType,
        suppliesType: details.suppliesType,
        infusionSet1: details.infusionSet1,
        infQty1: details.infQty1,
        infusionSet2: details.infusionSet2,
        infQty2: details.infQty2,
      });

      await sendSMS(details.phone, messageText, { patientName: details.name });
      console.log(`[sms-queue] Confirmation text sent to item ${itemId}`);
      return { success: true, itemId };
    },
    { connection, concurrency: 2 }
  );

  _smsWorker.on("completed", (job, result) => {
    console.log(`[sms-queue] Completed: confirmation SMS for item ${result.itemId}`);
  });

  _smsWorker.on("failed", (job, err) => {
    const { notifySmsError } = require("./notify");
    if (job.attemptsMade >= job.opts.attempts) {
      console.error(`[sms-queue] DEAD LETTER — confirmation SMS for item ${job.data.itemId} failed after ${job.attemptsMade} attempts: ${err.message}`);
      notifySmsError(`Confirmation SMS dead letter: ${err.message}`, job.data.itemId);
    }
  });

  _smsWorker.on("error", (err) => {
    console.error("[sms-queue] Worker error:", err.message);
  });

  console.log("[sms-queue] Confirmation SMS worker ready");
}

async function enqueueConfirmationSms(itemId, optOuts = {}, delayMs = 20_000) {
  const job = await smsQueue.add(
    "send-confirmation-sms",
    { itemId, optOuts },
    { delay: delayMs }
  );
  console.log(`[sms-queue] Enqueued confirmation SMS for item ${itemId} (delay: ${delayMs / 1000}s, jobId: ${job.id})`);
  return job.id;
}

// ─── SMS Delivery Verification Queue ───
// Fires once per cron batch, 10 min after last send, and checks every messageId against
// the RC message-store API. A message RC failed is re-sent ONCE. Anything not settled yet —
// still Queued/Sent, a re-sent message, or a status check that errored — is checked again in
// a follow-up job (FOLLOW_UP_DELAYS_MS), so a slow or failed text is never left unknown.
// Alerts go out for what needs a human: a re-send that could not be sent, a message that
// failed again after its re-send, and anything still unsettled after the last follow-up.

const FOLLOW_UP_DELAYS_MS = [30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000]; // +30m, +2h, +6h
const MAX_RESENDS = 1;

const smsVerifyQueue = new Queue("reorder-sms-verify", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "fixed", delay: 60_000 }, // retry after 1 min if worker itself errors
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
});

let _smsVerifyWorker = null;

const who = (m) => `${m.name} (${m.uid})`;

/**
 * One verification pass. Pure apart from `deps`, so it is testable without RC or Redis.
 * @param {Array} sentMessages  [{uid, name, phone, messageId, originalMessage, resends?}]
 * @param {number} round        0 = first check (10 min after send), 1.. = follow-ups
 * @param {object} deps         {checkMessageStatus, sendSMS, notifyError, enqueueFollowUp(msgs, delayMs, round), sleep}
 */
async function verifySmsBatch(sentMessages, round, deps) {
  const { checkMessageStatus, sendSMS, notifyError, enqueueFollowUp } = deps;
  const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const label = round === 0 ? "first check" : `follow-up ${round}/${FOLLOW_UP_DELAYS_MS.length}`;
  console.log(`[sms-verify] Verifying ${sentMessages.length} message(s) — ${label}`);

  const delivered = [];
  const failed = [];
  const stuck = [];
  const checkErrors = [];

  for (const msg of sentMessages) {
    try {
      const status = await checkMessageStatus(msg.messageId);
      if (status.status === "Delivered") {
        delivered.push(msg);
      } else if (status.status === "DeliveryFailed" || status.status === "SendingFailed") {
        failed.push({ ...msg, rcStatus: status.status });
      } else {
        stuck.push({ ...msg, rcStatus: status.status }); // Queued / Sent — not settled yet
      }
    } catch (err) {
      console.error(`[sms-verify] Error checking messageId ${msg.messageId}: ${err.message}`);
      checkErrors.push({ ...msg, error: err.message });
    }
    await sleep(500); // respect RC rate limits
  }

  console.log(`[sms-verify] Results (${label}): ${delivered.length} delivered, ${failed.length} failed, ${stuck.length} still pending, ${checkErrors.length} check errors`);
  for (const m of delivered) {
    if (round > 0 || m.resends) console.log(`[sms-verify] Delivered on ${label}: ${who(m)}, messageId=${m.messageId}`);
  }

  // ─── Re-send failed deliveries, once per patient text ───
  const resent = [];
  const resendErrors = [];
  const failedAgain = [];
  for (const msg of failed) {
    if ((msg.resends || 0) >= MAX_RESENDS) {
      failedAgain.push(msg);
      continue;
    }
    try {
      console.log(`[sms-verify] Retrying SMS for ${msg.name} (UID ${msg.uid}) — original status: ${msg.rcStatus}`);
      const r = await sendSMS(msg.phone, msg.originalMessage, { patientName: msg.name });
      if (!r || !r.messageId) throw new Error("re-send returned no messageId");
      console.log(`[sms-verify] Re-sent ${who(msg)}: ${msg.messageId} → ${r.messageId}`);
      resent.push({ ...msg, previousMessageId: msg.messageId, messageId: r.messageId, resends: (msg.resends || 0) + 1 });
    } catch (err) {
      console.error(`[sms-verify] Retry failed for ${msg.name} (UID ${msg.uid}): ${err.message}`);
      resendErrors.push({ ...msg, retryError: err.message });
    }
    await sleep(1000);
  }

  // ─── Anything unsettled is checked again later ───
  const pending = [...stuck, ...checkErrors, ...resent].map(({ rcStatus, error, ...m }) => m);
  const nextDelay = FOLLOW_UP_DELAYS_MS[round];
  let followUpQueued = false;
  if (pending.length > 0 && nextDelay !== undefined) {
    await enqueueFollowUp(pending, nextDelay, round + 1);
    followUpQueued = true;
    for (const m of stuck) console.log(`[sms-verify] Still ${m.rcStatus} on ${label}: ${who(m)}, messageId=${m.messageId} — re-checking in ${nextDelay / 60000} min`);
  }

  // ─── Alert on anything that needs human attention ───
  const problems = [];
  if (resendErrors.length > 0) {
    problems.push(`${resendErrors.length} SMS failed delivery AND the re-send could not be sent:\n` +
      resendErrors.map(r => `  - ${who(r)}: ${r.rcStatus} → retry error: ${r.retryError}`).join("\n"));
  }
  if (failedAgain.length > 0) {
    problems.push(`${failedAgain.length} SMS failed again after being re-sent — the patient has NOT received the reorder text:\n` +
      failedAgain.map(r => `  - ${who(r)}: ${r.rcStatus}, messageId=${r.messageId}`).join("\n"));
  }
  if (!followUpQueued && (stuck.length > 0 || checkErrors.length > 0)) {
    problems.push(`${stuck.length + checkErrors.length} SMS still not confirmed delivered after the last re-check — check RingCentral or contact the patient:\n` +
      [...stuck.map(s => `  - ${who(s)}: status=${s.rcStatus}, messageId=${s.messageId}`),
       ...checkErrors.map(e => `  - ${who(e)}: status check error: ${e.error}, messageId=${e.messageId}`)].join("\n"));
  }
  if (problems.length > 0) {
    const alertBody = `SMS Delivery Verification (${label}) — ${sentMessages.length} checked, ${delivered.length} delivered, ${problems.length} issue(s):\n\n${problems.join("\n\n")}`;
    console.error(`[sms-verify] ALERT:\n${alertBody}`);
    await notifyError("SMS Delivery Issues", alertBody, { tags: ["warning", "sms"] });
  }

  return {
    round,
    total: sentMessages.length,
    delivered: delivered.length,
    failed: failed.length,
    retried: resent.length,
    retryFailed: resendErrors.length + failedAgain.length,
    stuck: stuck.length,
    checkErrors: checkErrors.length,
    followUp: followUpQueued ? pending.length : 0,
  };
}

function startSmsVerifyWorker() {
  const { checkMessageStatus, sendSMS } = require("./sms");
  const { notifyError } = require("./notify");

  _smsVerifyWorker = new Worker(
    "reorder-sms-verify",
    async (job) => {
      const { sentMessages, round = 0 } = job.data;
      return verifySmsBatch(sentMessages, round, {
        checkMessageStatus,
        sendSMS,
        notifyError,
        enqueueFollowUp: (msgs, delayMs, nextRound) => enqueueSmsBatchVerification(msgs, delayMs, nextRound),
      });
    },
    { connection, concurrency: 1 }
  );

  _smsVerifyWorker.on("completed", (job, result) => {
    console.log(`[sms-verify] Verification complete (round ${result.round}): ${result.delivered}/${result.total} delivered, ${result.retried} re-sent, ${result.stuck} still pending, ${result.followUp} queued for re-check`);
  });

  _smsVerifyWorker.on("failed", (job, err) => {
    const { notifyError } = require("./notify");
    console.error(`[sms-verify] Verification job failed: ${err.message}`);
    notifyError("SMS Verify Job Failed", `Batch verification failed after ${job.attemptsMade} attempts: ${err.message}`, { tags: ["warning", "sms"] });
  });

  _smsVerifyWorker.on("error", (err) => {
    console.error("[sms-verify] Worker error:", err.message);
  });

  console.log("[sms-verify] SMS delivery verification worker ready");
}

/**
 * Enqueue a batch of sent messageIds for delivery verification.
 * @param {Array<{uid, messageId, phone, name, originalMessage, resends?}>} sentMessages
 * @param {number} delayMs — how long to wait before checking (default 10 min)
 * @param {number} round — 0 for the first check, 1.. for follow-ups
 */
async function enqueueSmsBatchVerification(sentMessages, delayMs = 10 * 60 * 1000, round = 0) {
  if (!sentMessages || sentMessages.length === 0) return null;
  const job = await smsVerifyQueue.add(
    round === 0 ? "verify-sms-batch" : "verify-sms-followup",
    { sentMessages, round },
    { delay: delayMs }
  );
  console.log(`[sms-verify] Enqueued ${round === 0 ? "batch verification" : `follow-up ${round}`} for ${sentMessages.length} message(s) (delay: ${delayMs / 1000}s, jobId: ${job.id})`);
  return job.id;
}

// ─── OOP Estimate Refresh Queue — RETIRED (2026-10) ───
// The `reorder-oop-refresh` queue recomputed a row's OOP_ESTIMATE after a Monday
// webhook said an input changed, and ran the board-wide backfill. The Stedi backend
// now resolves benefits and writes that column itself, so nothing here may write it.
// The three functions keep their names so monday.js, index.js and any script that
// loads them keep working; they log once, do nothing, and never touch Redis. No
// Queue or Worker is created, so a stale job left in Redis from before is never
// picked up either.

let _oopRetiredLogged = false;
function logOopRetired(what) {
  if (_oopRetiredLogged) return;
  _oopRetiredLogged = true;
  console.log(`[oop-refresh] retired (${what}) — the Stedi backend writes OOP Estimate (text_mm404p7d); no refresh queue runs here`);
}

function startOopRefreshWorker() {
  logOopRetired("worker not started");
}

async function enqueueOopRefresh(itemId, source) {
  logOopRetired(`enqueue ignored: ${source || "webhook"}`);
  return null;
}

async function enqueueOopBackfill(itemIds) {
  logOopRetired("backfill ignored");
  return 0;
}

function queueHealthCheck() {
  return {
    mondayWriter: _workerReady,
    reorderProcessor: !!_reorderWorker,
    smsWorker: !!_smsWorker,
    smsVerifyWorker: !!_smsVerifyWorker,
    oopRefreshWorker: "retired",
  };
}

async function closeQueue() {
  if (_worker) await _worker.close();
  if (_reorderWorker) await _reorderWorker.close();
  if (_smsWorker) await _smsWorker.close();
  if (_smsVerifyWorker) await _smsVerifyWorker.close();
  await mondayWriteQueue.close();
  await reorderQueue.close();
  await smsQueue.close();
  await smsVerifyQueue.close();
}

module.exports = {
  mondayWriteQueue,
  startWorker,
  startReorderWorker,
  startSmsWorker,
  startSmsVerifyWorker,
  startOopRefreshWorker,
  enqueueOopRefresh,
  enqueueOopBackfill,
  enqueueWrite,
  enqueueWriteAndWait,
  enqueueReorderPatient,
  enqueueConfirmationSms,
  enqueueSmsBatchVerification,
  verifySmsBatch,
  FOLLOW_UP_DELAYS_MS,
  checkBatchComplete,
  queueHealthCheck,
  closeQueue,
};
