// ─── Reorder Cron Scheduler ───
// Runs 4x/day (every 6 hours) to check for patients whose
// "Days to Order" column has flipped to "20 Days".
// For each eligible patient:
//   1. Generate a reorder token + link
//   2. Store token + link in Monday
//   3. Send initial reorder text via RingCentral
//   4. Mark "Reorder Text Sent" column so we don't re-process

const cron = require("node-cron");
const { generateReorderToken } = require("./auth");
const {
  getPatientsAt20DaysOut,
  storeTokenInMonday,
  markReorderTextSent,
} = require("./monday");
const { sendSMS, buildReorderText } = require("./sms");
const { notifyCronError, notifySmsError, notifyCronSummary } = require("./notify");

const REORDER_URL = process.env.REORDER_URL || "https://medically-modern.github.io/reorder-patient-form";

// ─── Process a single patient ───

async function processPatient(patient) {
  const { itemId, name, uid, phone, nextOrder } = patient;

  if (!uid) {
    console.warn(`[cron] Skipping item ${itemId} (${name}) — no UID`);
    return { skipped: true, reason: "no UID" };
  }

  if (!phone) {
    console.warn(`[cron] Skipping UID ${uid} (${name}) — no phone number`);
    await notifyCronError(`Patient "${name}" has no phone number — cannot send reorder text`, uid);
    return { skipped: true, reason: "no phone" };
  }

  try {
    // 1. Generate reorder token (20-day TTL set in config)
    const token = await generateReorderToken(uid);
    const link = `${REORDER_URL}?token=${token}`;

    // 2. Store in Monday (token + link columns)
    await storeTokenInMonday(uid, token, link);

    // 3. Send the initial reorder text
    const messageText = buildReorderText(name, nextOrder || "TBD", link);
    const smsResult = await sendSMS(phone, messageText, { patientName: name });

    // 4. Mark as sent in Monday
    const sentTimestamp = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }) + " ET";
    await markReorderTextSent(itemId, sentTimestamp);

    console.log(`[cron] Processed UID ${uid} (${name}) — link generated, text sent`);
    return { success: true, uid, simulated: smsResult.simulated || false };
  } catch (err) {
    console.error(`[cron] Error processing UID ${uid} (${name}):`, err.message);
    await notifyCronError(`Failed to process "${name}": ${err.message}`, uid);
    return { error: true, uid, message: err.message };
  }
}

// ─── Main cron job ───

async function checkAndProcessReorders() {
  console.log(`[cron] ═══ Reorder check started at ${new Date().toISOString()} ═══`);

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

    console.log(`[cron] ${eligible.length} patient(s) eligible for reorder text`);

    if (eligible.length === 0) {
      console.log(`[cron] Nothing to process`);
      return { processed: 0, skipped: patients.length };
    }

    // Process sequentially to respect Monday rate limits
    const results = [];
    for (let i = 0; i < eligible.length; i++) {
      const result = await processPatient(eligible[i]);
      results.push(result);

      // Small delay between patients to avoid rate limits
      if (i < eligible.length - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const errored = results.filter((r) => r.error).length;
    const skipped = results.filter((r) => r.skipped).length;

    console.log(`[cron] ═══ Reorder check complete: ${succeeded} sent, ${errored} errors, ${skipped} skipped ═══`);

    // Notify if there were any errors
    await notifyCronSummary(succeeded, errored, skipped);

    return { processed: succeeded, errors: errored, skipped };
  } catch (err) {
    console.error(`[cron] Fatal error in reorder check:`, err.message, err.stack);
    await notifyCronError(`Fatal cron error: ${err.message}\n${err.stack || ""}`);
    return { error: err.message };
  }
}

// ─── Schedule: runs at 6 AM, 12 PM, 6 PM, 12 AM ET ───

function startCron() {
  // Runs at 6 AM, 12 PM, 6 PM, 12 AM Eastern Time
  // node-cron handles DST automatically via the timezone option
  const schedule = "0 0,6,12,18 * * *";

  const task = cron.schedule(schedule, () => {
    checkAndProcessReorders().catch((err) => {
      console.error("[cron] Unhandled error:", err);
      notifyCronError(`Unhandled cron error: ${err.message}`);
    });
  }, {
    timezone: "America/New_York",
  });

  console.log(`[cron] Reorder scheduler started — runs 4x/day at 6 AM, 12 PM, 6 PM, 12 AM ET`);

  return task;
}

module.exports = {
  startCron,
  checkAndProcessReorders,  // Exported for manual trigger / testing
};
