// verifySmsBatch — stuck, re-sent and unchecked texts are re-checked; nothing is left unknown.
// No RC, Redis or network: every dependency is a stub.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

// queue.js requires bullmq at load; resolve it to a stub so node_modules is not needed.
const src = path.join(__dirname, "../src");
const stubId = path.join(src, "__bullmq_stub__.js");
if (!Module._resolveFilename.__stubbed) {
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) { return req === "bullmq" ? stubId : orig.call(this, req, ...rest); };
  Module._resolveFilename.__stubbed = true;
}
const m = new Module(stubId); m.loaded = true;
m.exports = { Queue: class { add() {} on() {} close() {} }, Worker: class { on() {} close() {} } };
require.cache[stubId] = m;
delete require.cache[path.join(src, "queue.js")];
const { verifySmsBatch, FOLLOW_UP_DELAYS_MS } = require(path.join(src, "queue.js"));

const msg = (name, messageId, extra = {}) => ({ uid: name, name, phone: "+1", messageId, originalMessage: "hi", ...extra });

function deps(statuses, { sendFails = false } = {}) {
  const d = { followUps: [], alerts: [], sends: [] };
  let n = 0;
  d.checkMessageStatus = async (id) => {
    const s = statuses[id];
    if (s instanceof Error) throw s;
    return { status: s };
  };
  d.sendSMS = async (phone, text, opts) => {
    d.sends.push(opts.patientName);
    if (sendFails) throw new Error("RC down");
    return { messageId: `new-${++n}` };
  };
  d.notifyError = async (title, body) => { d.alerts.push(body); };
  d.enqueueFollowUp = async (msgs, delay, round) => { d.followUps.push({ msgs, delay, round }); };
  d.sleep = async () => {};
  return d;
}

test("a Queued text is re-checked later instead of only alerted", async () => {
  const d = deps({ a: "Delivered", b: "Queued" });
  const r = await verifySmsBatch([msg("A", "a"), msg("B", "b")], 0, d);
  assert.equal(r.delivered, 1);
  assert.equal(d.followUps.length, 1);
  assert.deepEqual(d.followUps[0].msgs.map(x => x.messageId), ["b"]);
  assert.equal(d.followUps[0].delay, FOLLOW_UP_DELAYS_MS[0]);
  assert.equal(d.followUps[0].round, 1);
  assert.equal(d.alerts.length, 0, "no alert while a re-check is still coming");
});

test("a failed text is re-sent once and the re-send itself is checked later", async () => {
  const d = deps({ a: "DeliveryFailed" });
  await verifySmsBatch([msg("A", "a")], 0, d);
  assert.deepEqual(d.sends, ["A"]);
  assert.equal(d.followUps.length, 1);
  const f = d.followUps[0].msgs[0];
  assert.equal(f.messageId, "new-1");
  assert.equal(f.previousMessageId, "a");
  assert.equal(f.resends, 1);
});

test("a re-sent text that fails again is alerted, not re-sent forever", async () => {
  const d = deps({ x: "DeliveryFailed" });
  const r = await verifySmsBatch([msg("A", "x", { resends: 1 })], 1, d);
  assert.deepEqual(d.sends, []);
  assert.equal(d.followUps.length, 0);
  assert.equal(r.retryFailed, 1);
  assert.match(d.alerts[0], /failed again after being re-sent/);
});

test("a status-check error is re-checked, not dropped", async () => {
  const d = deps({ a: new Error("timeout") });
  await verifySmsBatch([msg("A", "a")], 0, d);
  assert.deepEqual(d.followUps[0].msgs.map(x => x.messageId), ["a"]);
});

test("after the last follow-up, anything still unconfirmed raises an alert", async () => {
  const d = deps({ a: "Queued" });
  const last = FOLLOW_UP_DELAYS_MS.length;
  await verifySmsBatch([msg("A", "a")], last, d);
  assert.equal(d.followUps.length, 0);
  assert.equal(d.alerts.length, 1);
  assert.match(d.alerts[0], /still not confirmed delivered after the last re-check/);
  assert.match(d.alerts[0], /A \(A\): status=Queued, messageId=a/);
});

test("a re-send that cannot be sent is alerted", async () => {
  const d = deps({ a: "SendingFailed" }, { sendFails: true });
  await verifySmsBatch([msg("A", "a")], 0, d);
  assert.equal(d.followUps.length, 0);
  assert.match(d.alerts[0], /re-send could not be sent/);
});
