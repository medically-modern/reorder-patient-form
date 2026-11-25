// The Friday read shadow (fridayShadow.js): a read of Monday handed to Friday's /v2/shadow after the caller has its answer,
// never awaited, never throwing; off unless switched on; only reads touching a board Friday serves.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFridayShadow, touchesFriday } = require("../src/fridayShadow.js");

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const on = { FRIDAY_SHADOW: "1", FRIDAY_URL: "https://friday.example/", FRIDAY_API_KEY: "fk_live_test" };

test("which reads touch Friday's boards", () => {
  assert.equal(touchesFriday("query { boards(ids: [18406352652]) { id } }"), true);
  assert.equal(touchesFriday("query ($b: [ID!]) { boards(ids: $b) { id } }", { b: ["18410601299"] }), true);
  assert.equal(touchesFriday("query { items(ids: [1, 2]) { id } }"), true, "items by id name no board");
  assert.equal(touchesFriday("query { next_items_page(cursor: \"x\") { items { id } } }"), true);
  assert.equal(touchesFriday("query { boards(ids: [18392794310]) { id } }"), false, "DTC Intake isn't Friday's");
  assert.equal(touchesFriday("mutation { change_simple_column_value(board_id: 18406352652, item_id: 1, column_id: \"x\", value: \"y\") { id } }"), false);
  assert.equal(touchesFriday(""), false);
});

test("off unless switched on, and says why", () => {
  const logs = [];
  const s = createFridayShadow({ env: {}, log: (m) => logs.push(m), fetchImpl: async () => { throw new Error("never"); } });
  assert.equal(s.enabled, false);
  s.onRead({ query: "query { boards(ids: [18406352652]) { id } }", text: "{}" });
  assert.match(logs[0], /off \(FRIDAY_SHADOW is not 1\)/);
  assert.equal(s.health().stats.handed, 0);
});

test("a read handed over after the caller's turn: Monday's text spliced in whole, the label, the key; the outcome counted", async () => {
  const sent = [];
  const s = createFridayShadow({ env: { ...on, FRIDAY_SHADOW_READER: "automate-dvs" }, log: () => {}, reader: "ignored-default",
    fetchImpl: async (url, o) => { sent.push({ url, o }); return { ok: true, json: async () => ({ outcome: "same" }) }; } });
  const text = '{"data":{"boards":[{"id":"18406352652"}]}}';
  s.onRead({ query: "query ($b: ID!) { boards(ids: [$b]) { id } }", variables: { b: "18406352652" }, apiVersion: "2024-10", status: 200, text, ms: 812 });
  assert.equal(sent.length, 0, "nothing sent in the caller's turn");
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://friday.example/v2/shadow");
  assert.equal(sent[0].o.headers.Authorization, "Bearer fk_live_test");
  const body = JSON.parse(sent[0].o.body);
  assert.equal(body.reader, "automate-dvs");
  assert.equal(body.api_version, "2024-10");
  assert.deepEqual(body.monday, { status: 200, ms: 812, body: JSON.parse(text) });
  assert.ok(sent[0].o.body.includes(text), "Monday's answer is the text as it came");
  assert.equal(s.health().stats.same, 1);
});

test("only a parse: sent re-encoded; FRIDAY_SHADOW_URL and _KEY win over the forward's", async () => {
  const sent = [];
  const s = createFridayShadow({ env: { ...on, FRIDAY_SHADOW_URL: "https://shadow.example", FRIDAY_SHADOW_KEY: "fk_live_ro" }, log: () => {}, reader: "stedi",
    fetchImpl: async (url, o) => { sent.push({ url, o }); return { ok: true, json: async () => ({ outcome: "differs" }) }; } });
  s.onRead({ query: "query { items(ids: [5]) { id } }", json: { data: { items: [{ id: "5" }] } } });
  await settle();
  assert.equal(sent[0].url, "https://shadow.example/v2/shadow");
  assert.equal(sent[0].o.headers.Authorization, "Bearer fk_live_ro");
  assert.equal(JSON.parse(sent[0].o.body).reader, "stedi");
  assert.equal(s.health().stats.differs, 1);
});

test("never throws, never awaited: Friday down, Friday slow, a busy cap, too big, sampled out, not Friday's", async () => {
  let release;
  const s = createFridayShadow({ env: { ...on, FRIDAY_SHADOW_INFLIGHT: "1", FRIDAY_SHADOW_MAX_BYTES: "100" }, log: () => {},
    fetchImpl: () => new Promise((r) => { release = r; }) });
  const read = { query: "query { boards(ids: [18406352652]) { id } }", text: '{"data":{}}' };
  s.onRead(read);                                   // in flight
  await settle();
  s.onRead(read);                                   // dropped: busy
  s.onRead({ ...read, text: JSON.stringify({ data: { x: "y".repeat(500) } }) });
  s.onRead({ query: "query { boards(ids: [18392794310]) { id } }", text: "{}" });
  assert.deepEqual([s.health().stats.dropped_busy, s.health().stats.not_friday], [2, 1], "the oversized one is dropped as busy too: busy is checked first");
  release({ ok: false, json: async () => ({}) });
  await settle();
  assert.equal(s.health().stats.failed, 1, "a refusal is a count");
  s.onRead({ ...read, text: JSON.stringify({ data: { x: "y".repeat(500) } }) });
  assert.equal(s.health().stats.dropped_size, 1);

  const down = createFridayShadow({ env: on, log: () => {}, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.doesNotThrow(() => down.onRead(read));
  assert.doesNotThrow(() => down.onRead({ query: undefined, text: "not json" }));
  assert.doesNotThrow(() => down.onRead());
  await settle();
  assert.equal(down.health().stats.failed >= 1, true);

  const sampled = createFridayShadow({ env: { ...on, FRIDAY_SHADOW_RATE: "0.1" }, log: () => {}, random: () => 0.5, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  sampled.onRead(read);
  assert.equal(sampled.health().stats.sampled_out, 1);
});

test("flush waits for a hand-off on its way, and gives up at its limit", async () => {
  let release;
  const s = createFridayShadow({ env: on, log: () => {}, fetchImpl: () => new Promise((r) => { release = r; }) });
  s.onRead({ query: "query { boards(ids: [18406352652]) { id } }", text: '{"data":{}}' });
  await settle();
  const t0 = Date.now();
  await s.flush(50);                                  // still on its way: gives up at the limit
  assert.ok(Date.now() - t0 >= 40);
  setTimeout(() => release({ ok: true, json: async () => ({ outcome: "same" }) }), 10);
  await s.flush(2000);
  assert.equal(s.health().stats.same, 1);
  await s.flush();                                    // nothing on its way: at once
});
