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
  const { storeTokenInMonday, markReorderTextSent } = require("./monday");
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
      console.log(`[reorder-queue] Processing UID ${uid} (${name}) — attempt ${job.attemptsMade + 1}/${job.opts.attempts}`);

      // 1. Generate reorder token
      const token = await generateReorderToken(uid);
      const link = `${REORDER_URL}?token=${token}`;

      // 2. Store in Monday
      await storeTokenInMonday(uid, token, link);

      // 3. Send SMS
      const messageText = buildReorderText(name, nextOrder || "TBD", link);
      const smsResult = await sendSMS(phone, messageText, { patientName: name });

      // 4. Mark as sent in Monday
      const sentTimestamp = new Date().toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      }) + " ET";
      await markReorderTextSent(itemId, sentTimestamp);

      // 5. Store result for batch verification
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

async function checkBatchComplete(batchId) {
  if (!batchId) return;
  const { redis } = require("./redis");

  const completedCount = await redis.incr(`sms-verify:${batchId}:completed`);
  await redis.expire(`sms-verify:${batchId}:completed`, 7200);

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
    `reorder-${patient.uid}`,
    { patient, batchId },
    { jobId: `reorder-${patient.uid}-${batchId}` } // Dedup by UID + batch
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
      const { uid, optOuts = {} } = job.data;
      console.log(`[sms-queue] Processing confirmation SMS for UID ${uid} (attempt ${job.attemptsMade + 1}/${job.opts.attempts})`);

      const details = await getPatientOrderDetails(uid);
      if (!details) throw new Error(`Patient ${uid} not found in Monday`);
      if (!details.phone) throw new Error(`No phone for UID ${uid}`);

      const messageText = buildConfirmationText({
        name: details.name,
        address: details.address,
        nextOrder: details.nextOrder,
        sensorsType: optOuts.sensorsOptOut ? null : details.sensorsType,
        suppliesType: optOuts.cartridgesOptOut ? null : details.suppliesType,
        infusionSet1: optOuts.infusionOptOut ? null : details.infusionSet1,
        infQty1: optOuts.infusionOptOut ? null : details.infQty1,
        infusionSet2: optOuts.infusionOptOut ? null : details.infusionSet2,
        infQty2: optOuts.infusionOptOut ? null : details.infQty2,
      });

      await sendSMS(details.phone, messageText, { patientName: details.name });
      console.log(`[sms-queue] Confirmation text sent to UID ${uid}`);
      return { success: true, uid };
    },
    { connection, concurrency: 2 }
  );

  _smsWorker.on("completed", (job, result) => {
    console.log(`[sms-queue] Completed: confirmation SMS for UID ${result.uid}`);
  });

  _smsWorker.on("failed", (job, err) => {
    const { notifySmsError } = require("./notify");
    if (job.attemptsMade >= job.opts.attempts) {
      console.error(`[sms-queue] DEAD LETTER — confirmation SMS for UID ${job.data.uid} failed after ${job.attemptsMade} attempts: ${err.message}`);
      notifySmsError(`Confirmation SMS dead letter: ${err.message}`, job.data.uid);
    }
  });

  _smsWorker.on("error", (err) => {
    console.error("[sms-queue] Worker error:", err.message);
  });

  console.log("[sms-queue] Confirmation SMS worker ready");
}

async function enqueueConfirmationSms(uid, optOuts = {}, delayMs = 20_000) {
  const job = await smsQueue.add(
    "send-confirmation-sms",
    { uid, optOuts },
    { delay: delayMs }
  );
  console.log(`[sms-queue] Enqueued confirmation SMS for UID ${uid} (delay: ${delayMs / 1000}s, jobId: ${job.id})`);
  return job.id;
}

// ─── SMS Delivery Verification Queue ───
// Fires once per cron batch, 10 min after last send.
// Checks every messageId against RC message-store API.
// Retries failed deliveries, alerts on anything still stuck.

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

function startSmsVerifyWorker() {
  const { checkMessageStatus, sendSMS, buildReorderText } = require("./sms");
  const { notifyError } = require("./notify");

  _smsVerifyWorker = new Worker(
    "reorder-sms-verify",
    async (job) => {
      const { sentMessages } = job.data;
      console.log(`[sms-verify] Verifying ${sentMessages.length} message(s) (attempt ${job.attemptsMade + 1})`);

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
            // Still Queued or Sent after 10 min — suspicious
            stuck.push({ ...msg, rcStatus: status.status });
          }
        } catch (err) {
          console.error(`[sms-verify] Error checking messageId ${msg.messageId}: ${err.message}`);
          checkErrors.push({ ...msg, error: err.message });
        }

        // Small delay between RC API calls to respect rate limits
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`[sms-verify] Results: ${delivered.length} delivered, ${failed.length} failed, ${stuck.length} stuck, ${checkErrors.length} check errors`);

      // ─── Auto-retry failed deliveries ───
      const retryResults = [];
      for (const msg of failed) {
        try {
          console.log(`[sms-verify] Retrying SMS for ${msg.name} (UID ${msg.uid}) — original status: ${msg.rcStatus}`);
          const retryResult = await sendSMS(msg.phone, msg.originalMessage, { patientName: msg.name });
          retryResults.push({ ...msg, retried: true, newMessageId: retryResult.messageId });
        } catch (err) {
          console.error(`[sms-verify] Retry failed for ${msg.name} (UID ${msg.uid}): ${err.message}`);
          retryResults.push({ ...msg, retried: false, retryError: err.message });
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      // ─── Alert on anything that needs human attention ───
      const problems = [];

      const retryFailures = retryResults.filter(r => !r.retried);
      if (retryFailures.length > 0) {
        problems.push(`${retryFailures.length} SMS failed delivery AND retry failed:\n` +
          retryFailures.map(r => `  - ${r.name} (${r.uid}): ${r.rcStatus} → retry error: ${r.retryError}`).join("\n"));
      }

      if (stuck.length > 0) {
        problems.push(`${stuck.length} SMS still not delivered after 10 min (RC may be slow):\n` +
          stuck.map(s => `  - ${s.name} (${s.uid}): status=${s.rcStatus}, messageId=${s.messageId}`).join("\n"));
      }

      if (checkErrors.length > 0) {
        problems.push(`${checkErrors.length} SMS could not be status-checked:\n` +
          checkErrors.map(e => `  - ${e.name} (${e.uid}): ${e.error}`).join("\n"));
      }

      if (problems.length > 0) {
        const alertBody = `SMS Delivery Verification — ${sentMessages.length} total, ${delivered.length} delivered, ${problems.length} issue(s):\n\n${problems.join("\n\n")}`;
        console.error(`[sms-verify] ALERT:\n${alertBody}`);
        await notifyError("SMS Delivery Issues", alertBody, { tags: ["warning", "sms"] });
      }

      const retrySuccesses = retryResults.filter(r => r.retried);
      if (retrySuccesses.length > 0) {
        console.log(`[sms-verify] ${retrySuccesses.length} failed SMS(s) re-sent successfully`);
      }

      return {
        total: sentMessages.length,
        delivered: delivered.length,
        failed: failed.length,
        retried: retrySuccesses.length,
        retryFailed: retryFailures.length,
        stuck: stuck.length,
        checkErrors: checkErrors.length,
      };
    },
    { connection, concurrency: 1 }
  );

  _smsVerifyWorker.on("completed", (job, result) => {
    console.log(`[sms-verify] Batch verification complete: ${result.delivered}/${result.total} delivered, ${result.retried} retried, ${result.stuck} stuck`);
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
 * @param {Array<{uid, messageId, phone, name, originalMessage}>} sentMessages
 * @param {number} delayMs — how long to wait before checking (default 10 min)
 */
async function enqueueSmsBatchVerification(sentMessages, delayMs = 10 * 60 * 1000) {
  if (!sentMessages || sentMessages.length === 0) return null;
  const job = await smsVerifyQueue.add(
    "verify-sms-batch",
    { sentMessages },
    { delay: delayMs }
  );
  console.log(`[sms-verify] Enqueued batch verification for ${sentMessages.length} message(s) (delay: ${delayMs / 1000}s, jobId: ${job.id})`);
  return job.id;
}

function queueHealthCheck() {
  return {
    mondayWriter: _workerReady,
    reorderProcessor: !!_reorderWorker,
    smsWorker: !!_smsWorker,
    smsVerifyWorker: !!_smsVerifyWorker,
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
  enqueueWrite,
  enqueueWriteAndWait,
  enqueueReorderPatient,
  enqueueConfirmationSms,
  enqueueSmsBatchVerification,
  checkBatchComplete,
  queueHealthCheck,
  closeQueue,
};
