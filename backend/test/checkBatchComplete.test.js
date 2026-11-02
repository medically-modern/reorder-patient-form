// checkBatchComplete — the cron's post-enqueue check must not count as a job completion.
// bullmq and ./redis are stubbed in the require cache: no Redis, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function fakeRedis() {
  const kv = new Map();
  const lists = new Map();
  return {
    kv, lists,
    async incr(k) { const v = parseInt(kv.get(k) || "0", 10) + 1; kv.set(k, String(v)); return v; },
    async expire() { return 1; },
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v, ...args) { if (args.includes("NX") && kv.has(k)) return null; kv.set(k, String(v)); return "OK"; },
    async rpush(k, v) { const l = lists.get(k) || []; l.push(v); lists.set(k, l); return l.length; },
    async lrange(k) { return lists.get(k) || []; },
    async del(...ks) { ks.forEach(k => { kv.delete(k); lists.delete(k); }); return ks.length; },
  };
}

function loadQueue(redis) {
  const src = path.join(__dirname, "../src");
  const added = [];
  class Queue { constructor(name) { this.name = name; added.push(this); this.jobs = []; }
    async add(n, data) { this.jobs.push(data); return { id: this.jobs.length }; }
    on() {} async close() {} }
  class Worker { on() {} async close() {} }
  // Resolve "bullmq" to a stub even when node_modules is not installed.
  const Module = require("node:module");
  const stubId = path.join(src, "__bullmq_stub__.js");
  if (!Module._resolveFilename.__stubbed) {
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req, ...rest) {
      return req === "bullmq" ? stubId : orig.call(this, req, ...rest);
    };
    Module._resolveFilename.__stubbed = true;
  }
  const stub = (exports) => { const m = new Module(stubId); m.loaded = true; m.exports = exports; return m; };
  require.cache[stubId] = stub({ Queue, Worker });
  const redisId = path.join(src, "redis.js");
  require.cache[redisId] = stub({ redis });
  delete require.cache[path.join(src, "queue.js")];
  const q = require(path.join(src, "queue.js"));
  return { q, verifyQueue: () => added.find(x => x.name === "reorder-sms-verify") };
}

test("cron post-enqueue check does not close the batch one job early", async () => {
  const redis = fakeRedis();
  const { q, verifyQueue } = loadQueue(redis);
  const b = "cron-test";
  const push = (n) => redis.rpush(`sms-verify:${b}`, JSON.stringify({ name: n, messageId: n }));

  // Job A finishes before the cron has set `expected`
  await push("A"); await q.checkBatchComplete(b);
  // Cron sets expected = 2 and runs its read-only check
  await redis.set(`sms-verify:${b}:expected`, 2);
  await q.checkBatchComplete(b, { countCompletion: false });
  assert.equal(verifyQueue().jobs.length, 0, "batch must stay open while job B is running");

  // Job B (the last one) finishes — now both messages are verified
  await push("B"); await q.checkBatchComplete(b);
  assert.equal(verifyQueue().jobs.length, 1);
  assert.deepEqual(verifyQueue().jobs[0].sentMessages.map(m => m.name), ["A", "B"]);
});

test("post-enqueue check still closes a batch whose jobs all finished first", async () => {
  const redis = fakeRedis();
  const { q, verifyQueue } = loadQueue(redis);
  const b = "cron-test-2";
  await redis.rpush(`sms-verify:${b}`, JSON.stringify({ name: "A", messageId: "A" }));
  await q.checkBatchComplete(b);
  await redis.set(`sms-verify:${b}:expected`, 1);
  await q.checkBatchComplete(b, { countCompletion: false });
  assert.equal(verifyQueue().jobs.length, 1);
  assert.deepEqual(verifyQueue().jobs[0].sentMessages.map(m => m.name), ["A"]);
});
