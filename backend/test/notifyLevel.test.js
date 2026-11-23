// Every ntfy push carries exactly one severity tag (lvl-error / lvl-warn / lvl-info) appended to its
// own tags, for the Command Center alerts page; title, priority, body and URL are untouched.
const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.NTFY_BASE = "https://ntfy.test";
process.env.NTFY_TOPIC = "t";
const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url, ...init }); return new Response("", { status: 200 }); };
const notify = require("../src/notify.js");

test("levelTag: explicit level wins, otherwise it follows the priority", () => {
  assert.equal(notify.levelTag("info", "urgent"), "lvl-info");
  assert.equal(notify.levelTag("error", "default"), "lvl-error");
  assert.equal(notify.levelTag(undefined, "urgent"), "lvl-error");
  assert.equal(notify.levelTag(undefined, "high"), "lvl-warn");
  assert.equal(notify.levelTag(undefined, "default"), "lvl-info");
  assert.equal(notify.levelTag(undefined, "low"), "lvl-info");
});

test("pushes keep their headers and gain one lvl-* tag chosen by meaning", async () => {
  sent.length = 0;
  await notify.notifyCronSummary(5, 0, 1);           // success
  await notify.notifyCronSummary(5, 2, 1);           // partial
  await notify.notifyCronError("boom", "U1");        // failure at default (high) priority
  await notify.notifyUnhandled("Exception", new Error("x"));
  await notify.notifyError("Stock status unavailable", "m", { priority: "default", tags: ["package"], level: "warn" });
  assert.deepEqual(sent.map((c) => c.headers.Tags), [
    "white_check_mark,clock,lvl-info",
    "warning,clock,lvl-warn",
    "rotating_light,clock,lvl-error",
    "skull,lvl-error",
    "package,lvl-warn",
  ]);
  assert.deepEqual(sent.map((c) => c.headers.Priority), ["default", "high", "high", "urgent", "default"]);
  assert.equal(sent[0].headers.Title, "Reorder Cron: 5 sent");
  assert.equal(sent[0].url, "https://ntfy.test/t");
  assert.equal(sent.every((c) => c.headers.Tags.split(",").filter((t) => t.startsWith("lvl-")).length === 1), true);
});
