// The Friday forward is wired, not just written. Every Monday board write this service makes goes through
// mondayQuery or uploadFileToMonday (src/monday.js), and each hands Friday what Monday accepted only after
// Monday's answer has been read for errors, so a refused write never reaches Friday and Monday's answer
// comes back unchanged. A Monday write added anywhere else is a write Friday never hears: this file fails.
// Reads source only: no Redis, Monday or network (the repo's rule for its tests).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const SRC = join(__dirname, "..", "src");
const read = (f) => readFileSync(join(SRC, f), "utf8");
const between = (s, from, to) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));

test("mondayQuery forwards after every error check and before it returns Monday's answer", () => {
  const src = read("monday.js");
  assert.match(src, /const fridayForward = createFridayForward\(\{\s*env: process\.env, log: console\.log, service: "reorder-patient-form",/);
  const q = between(src, "async function mondayQuery(", "// ─── Queued write helper");
  const hook = q.indexOf("fridayForward.onMutation({ query, variables, data: data.data })");
  assert.ok(hook > -1, "mondayQuery hands the mutation to Friday");
  assert.ok(hook > q.lastIndexOf("throw new Error("), "only after Monday's errors have been read");
  assert.ok(hook < q.lastIndexOf("return data.data;"), "and before the answer is returned");
});

test("uploadFileToMonday forwards the file only once Monday has taken it", () => {
  const src = read("monday.js");
  const f = between(src, "async function uploadFileToMonday(", "// ─── Lookup token in Monday");
  const hook = f.indexOf("fridayForward.onFile({ itemId, column: columnId, filename: fileName, bytes: fileBuffer })");
  assert.ok(hook > -1, "the upload hands the file to Friday");
  assert.ok(hook > f.indexOf("if (data.errors)"), "only after Monday's errors have been read");
  assert.ok(f.slice(0, hook).includes("data.data?.add_file_to_column?.id"), "and only when Monday answered a file id");
  assert.ok(hook < f.indexOf("return { success: true"), "before the success is returned");
});

test("no other Monday write path exists in src", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".js"));
  const mondayFetchers = files.filter((f) => /api\.monday\.com/.test(read(f)));
  assert.deepEqual(mondayFetchers.sort(), ["checkLabels.js", "checkOopWebhooks.js", "monday.js"]);
  assert.equal((read("monday.js").match(/await fetch\(/g) || []).length, 2, "mondayQuery and the file upload are monday.js's only calls");
  assert.doesNotMatch(read("checkLabels.js"), /\bmutation\b/, "checkLabels only reads");
  // checkOopWebhooks deletes Monday webhooks (board structure, never a cell): Friday takes no such write.
  const hooks = read("checkOopWebhooks.js").match(/mutation[^`]*/g) || [];
  assert.ok(hooks.length > 0 && hooks.every((m) => /delete_webhook/.test(m)), "its one mutation is delete_webhook");
});

test("/health says whether the forward is on and what it has done", () => {
  assert.match(read("index.js"), /friday: require\("\.\/monday"\)\.fridayForward\.status\(\)/);
});
