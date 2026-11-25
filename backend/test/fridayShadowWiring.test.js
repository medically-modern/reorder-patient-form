// The Friday read shadow is wired, not just written. mondayQuery (src/monday.js) hands a READ to Friday's /v2/shadow
// only after Monday answered it without errors, on a later turn, never awaited; only the final try of its retries,
// never a mutation, never a refusal. No Redis, Monday or network: bullmq is a stand-in (its Queues would connect to
// Redis on load), and Monday and Friday are stub fetches.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SRC = join(__dirname, "..", "src");
const read = (f) => readFileSync(join(SRC, f), "utf8");
const between = (s, from, to) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test("mondayQuery hands the read over after every error check and retry, never awaited; /health shows it", () => {
  const src = read("monday.js");
  assert.match(src, /const fridayShadow = createFridayShadow\(\{ env: process\.env, log: console\.log, reader: "reorder-patient-form" \}\);/);
  const q = between(src, "async function mondayQuery(", "// ─── Queued write helper");
  const hook = q.indexOf("fridayShadow.onRead({");
  assert.ok(hook > -1, "mondayQuery hands the read to the shadow");
  assert.ok(hook > q.lastIndexOf("throw new Error("), "only after Monday's errors have been read");
  assert.ok(hook > q.lastIndexOf("return mondayQuery("), "after every retry, so only the final try's answer");
  assert.ok(hook < q.lastIndexOf("return data.data;"), "and before the answer is returned");
  assert.equal((src.match(/fridayShadow\.onRead/g) || []).length, 1, "one hook, in mondayQuery");
  assert.doesNotMatch(src, /await\s+fridayShadow/, "never awaited");
  assert.doesNotMatch(read("fridayShadow.js"), /api\.monday\.com/, "the shadow names no Monday address");
  assert.match(read("index.js"), /friday_shadow: require\("\.\/monday"\)\.fridayShadow\.health\(\)/);
});

test("a read reaches Friday after the caller has its answer; a mutation, a refusal and a retried try never do", async (t) => {
  process.env.FRIDAY_SHADOW = "1";
  process.env.FRIDAY_URL = "https://friday.test";
  process.env.FRIDAY_API_KEY = "fk_live_test";
  // bullmq's Queues connect to Redis when src/queue.js loads: a stand-in that does nothing
  class Inert { constructor() { return new Proxy(this, { get: (o, k) => (k in o ? o[k] : () => Promise.resolve()) }); } }
  const bull = require.resolve("bullmq");
  require.cache[bull] = { id: bull, filename: bull, loaded: true, exports: { Queue: Inert, Worker: Inert } };

  const monday = [], shadow = [];
  let answers = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://friday.test/v2/shadow") {
      shadow.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ outcome: "same" }), { status: 200 });
    }
    if (String(url).startsWith("https://friday.test")) throw new Error(`unexpected Friday call ${url}`);
    monday.push(JSON.parse(init.body));
    const [status, body] = answers.shift();
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  const m = require("../src/monday");
  m.fridayForward.stop?.();
  assert.equal(m.fridayShadow.enabled, true);

  const READ = "query ($ids: [ID!]) { items(ids: $ids) { id name } }";
  const mondayText = JSON.stringify({ data: { items: [{ id: "1", name: "x" }] } });
  answers = [[200, mondayText]];
  assert.deepEqual(await m.mondayQuery(READ, { ids: ["1"] }), JSON.parse(mondayText).data, "the caller gets Monday's answer unchanged");
  assert.equal(shadow.length, 0, "nothing handed over in the caller's turn");
  await settle();
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].reader, "reorder-patient-form");
  assert.equal(shadow[0].query, READ);
  assert.deepEqual(shadow[0].variables, { ids: ["1"] });
  assert.equal(shadow[0].api_version, "2024-10");
  assert.deepEqual(shadow[0].monday.body, JSON.parse(mondayText));

  // a mutation Monday took is never shadowed
  answers = [[200, { data: { change_column_value: { id: "1" } } }]];
  await m.mondayQuery('mutation { change_column_value(board_id: 18407459988, item_id: 1, column_id: "x", value: "{}") { id } }');
  // Monday refuses the read: the error reaches the caller as before, nothing handed over
  answers = [[200, { errors: [{ message: "bad column" }] }]];
  await assert.rejects(m.mondayQuery(READ, { ids: ["2"] }));
  await settle();
  assert.equal(shadow.length, 1, "neither a mutation nor a refused read is handed over");

  // a retried read (Monday 500, then its answer): one hand-off, of the final answer
  t.mock.timers.enable({ apis: ["setTimeout"] });
  answers = [[500, "busy"], [200, mondayText]];
  const p = m.mondayQuery(READ, { ids: ["3"] });
  await settle();
  t.mock.timers.tick(1000);
  await p;
  await settle();
  t.mock.timers.reset();
  assert.equal(monday.length, 5, "Monday called as before, the retry included");
  assert.equal(shadow.length, 2, "one hand-off for the retried read");
  assert.deepEqual(shadow[1].variables, { ids: ["3"] });
  assert.equal(shadow[1].monday.status, 200);
  assert.equal(m.fridayShadow.health().stats.same, 2);
});
