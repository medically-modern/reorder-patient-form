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

function queueHealthCheck() {
  return { worker: _workerReady, queue: !!mondayWriteQueue };
}

async function closeQueue() {
  if (_worker) await _worker.close();
  await mondayWriteQueue.close();
}

module.exports = {
  mondayWriteQueue,
  startWorker,
  enqueueWrite,
  enqueueWriteAndWait,
  queueHealthCheck,
  closeQueue,
};
