// The Friday forward against a fake Friday: off queues nothing; on, a Profile Send Off mutation and a
// file are delivered in order with the key, an idempotency key and the right shapes; Friday's answer
// decides retry, dead or wait-for-a-key; nothing here ever throws into the Monday path.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createFridayForward, shouldForward, boardIdOf, classify, summarize, nextDelayMs, RETRY_DELAYS_MS, MAX_ATTEMPTS, AUTH_RETRY_MS } = require("../src/fridayForward.js");

const PSO = "18406352652";
const MUT = `mutation($board:ID!,$group:String!,$name:String!,$cv:JSON!){ create_item(board_id:$board, group_id:$group, item_name:$name, column_values:$cv){ id } }`;
const env = { FRIDAY_FORWARD: "1", FRIDAY_URL: "https://friday.test/", FRIDAY_API_KEY: "fk_live_test" };

function fakeFriday() {
  const calls = [], answers = [];
  const impl = async (url, init) => {
    const a = answers.shift() || { status: 200, json: { applied: 1, skipped: 0, ignored: 0, problems: 0, operations: [] } };
    const call = { url, method: init.method, headers: init.headers };
    if (typeof init.body === "string") call.body = JSON.parse(init.body);
    else if (init.body instanceof FormData) { const f = init.body.get("files"); call.file = { name: f.name, type: f.type, size: f.size }; }
    calls.push(call);
    if (a.throw) throw new Error(a.throw);
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { "content-type": "application/json" } });
  };
  return { impl, calls, answers };
}
const make = (f, extra = {}) => { let t = 1_000_000; const fwd = createFridayForward({ env, log: () => {}, alert: async (title, body) => f.alerts?.push({ title, body }), fetchImpl: f.impl, service: "svc", now: () => t, ...extra }); fwd.stop(); fwd.advance = (ms) => { t += ms; }; return fwd; };

test("pure rules: which documents go, how an answer is classified, the backoff", () => {
  assert.equal(shouldForward({ query: MUT, variables: { board: PSO } }), true);
  assert.equal(shouldForward({ query: MUT, variables: { board: "18406060017" } }), false);
  assert.equal(shouldForward({ query: "mutation { x }", variables: {} }), true);
  assert.equal(shouldForward({ query: "query { boards { id } }", variables: { board: PSO } }), false);
  assert.equal(boardIdOf("mutation { create_item(board_id: 18406352652, item_name: \"x\") { id } }", {}), PSO);
  assert.equal(boardIdOf(MUT, { boardId: 18406352652 }), PSO);
  assert.equal(boardIdOf(MUT, { item: "1" }), null);
  assert.deepEqual(["done", "auth", "auth", "dead", "dead", "dead", "retry", "retry", "retry"], [200, 401, 403, 400, 404, 422, 500, 429, 0].map(classify));
  assert.deepEqual(RETRY_DELAYS_MS, [5_000, 30_000, 120_000, 600_000, 1_800_000]);
  assert.equal(MAX_ATTEMPTS, 6); assert.equal(AUTH_RETRY_MS, 600_000);
  assert.equal(nextDelayMs(1), 5_000); assert.equal(nextDelayMs(5), 1_800_000); assert.equal(nextDelayMs(6), null);
  assert.deepEqual(summarize({ applied: 2, skipped: 1, problems: 1, operations: [{ mutation: "create_item", status: "applied", columns: [{ column: "x", status: "skipped", reason: "no" }] }] }), { applied: 2, skipped: 1, ignored: 0, problems: 1, detail: [{ op: "create_item", column: "x", reason: "no" }] });
  assert.deepEqual(summarize({ files: [{ id: 1 }, { id: 2 }] }), { files: 2 });
});

test("off: nothing is queued and the tick says why", async () => {
  const f = fakeFriday();
  const off = createFridayForward({ env: { FRIDAY_URL: env.FRIDAY_URL, FRIDAY_API_KEY: env.FRIDAY_API_KEY }, log: () => {}, alert: null, fetchImpl: f.impl });
  assert.equal(off.enabled, false);
  assert.equal(off.onMutation({ query: MUT, variables: { board: PSO }, data: {} }), false);
  assert.equal(off.onFile({ itemId: "1", column: "file_x", bytes: Buffer.from("x") }), false);
  assert.deepEqual(await off.tick(), { skipped: "FRIDAY_FORWARD is not 1" });
  assert.equal(f.calls.length, 0);
  assert.equal(createFridayForward({ env: { FRIDAY_FORWARD: "1", FRIDAY_URL: env.FRIDAY_URL }, log: () => {}, alert: null }).why, "FRIDAY_API_KEY unset");
});

test("on: a create, its follow-up write and its file reach Friday in that order, with the right shapes", async () => {
  const f = fakeFriday();
  const fwd = make(f);
  const vars = { board: PSO, group: "group_mm1xf2jb", name: "x", cv: JSON.stringify({ text_a: "b" }) };
  const data = { create_item: { id: "9001" } };
  assert.equal(fwd.onMutation({ query: "query { items(ids: [1]) { id } }", variables: {}, data: {} }), false);
  assert.equal(fwd.onMutation({ query: MUT, variables: vars, data, actor: "Jane@MedicallyModern.com" }), true);
  assert.equal(fwd.onMutation({ query: "mutation($item:ID!,$group:String!){ move_item_to_group(item_id:$item, group_id:$group){ id } }", variables: { item: "9001", group: "g2" }, data: { move_item_to_group: { id: "9001" } } }), true);
  assert.equal(fwd.onFile({ itemId: 9001, column: "file_mm5zhy1", filename: "insurance-card-1.jpg", contentType: "image/jpeg", bytes: Buffer.from("jpegbytes") }), true);
  assert.equal(fwd.queue.length, 3);
  const r1 = await fwd.tick();
  assert.equal(r1.done, true);
  assert.equal(f.calls[0].url, "https://friday.test/v1/monday/write");
  assert.equal(f.calls[0].headers.authorization, "Bearer fk_live_test");
  assert.match(f.calls[0].headers["idempotency-key"], /^svc-[0-9a-f-]{36}$/);
  assert.equal(f.calls[0].headers["x-friday-actor"], "jane@medicallymodern.com");
  assert.deepEqual(f.calls[0].body, { query: MUT, variables: vars, data });
  assert.equal((await fwd.tick()).done, true);
  assert.equal(f.calls[1].headers["x-friday-actor"], undefined);
  f.answers.push({ status: 201, json: { files: [{ id: 5 }] } });
  const r3 = await fwd.tick();
  assert.deepEqual(r3.summary, { files: 1 });
  assert.equal(f.calls[2].url, "https://friday.test/v1/boards/profile_send_off/items/9001/files/file_mm5zhy1");
  assert.deepEqual(f.calls[2].file, { name: "insurance-card-1.jpg", type: "image/jpeg", size: 9 });
  assert.match(f.calls[2].headers["idempotency-key"], /^svc-/);
  assert.deepEqual(await fwd.tick(), { idle: true });
  assert.equal(fwd.status().delivered, 2); assert.equal(fwd.status().files_delivered, 1); assert.equal(fwd.status().queued_now, 0);
});

test("a 503 is retried with backoff under the same idempotency key, holding the rows behind it; the sixth failure is dead with one alert", async () => {
  const f = fakeFriday(); f.alerts = [];
  const fwd = make(f);
  fwd.onMutation({ query: MUT, variables: { board: PSO }, data: {} });
  fwd.onMutation({ query: MUT, variables: { board: PSO }, data: {} });
  const delays = [];
  for (let n = 1; n <= 6; n++) {
    f.answers.push({ status: 503, json: { error: { message: "down" } } });
    const r = await fwd.tick();
    if (n < 6) { assert.equal(r.retry, true); assert.equal(r.error, "HTTP 503: down"); delays.push(r.in); assert.ok((await fwd.tick()).waiting > 0, "the queue waits"); fwd.advance(r.in); }
    else { assert.equal(r.dead, true); }
  }
  assert.deepEqual(delays, RETRY_DELAYS_MS);
  assert.equal(new Set(f.calls.slice(0, 6).map((c) => c.headers["idempotency-key"])).size, 1, "one key across the retries");
  assert.equal(f.alerts.length, 1); assert.match(f.alerts[0].title, /^svc: a Friday forward gave up/);
  assert.equal((await fwd.tick()).done, true, "the next row goes once the dead one is dropped");
  assert.equal(fwd.status().dead, 1); assert.equal(fwd.status().retries, 5);
});

test("a refusal Friday read is dead at once; a bad key waits ten minutes and never dies; no answer is a retry", async () => {
  const f = fakeFriday(); f.alerts = [];
  const fwd = make(f);
  fwd.onMutation({ query: MUT, variables: { board: PSO }, data: {} });
  f.answers.push({ status: 400, json: { error: { code: "bad_request", message: "query is not a mutation" } } });
  assert.deepEqual(await fwd.tick(), { id: 1, dead: true, error: "HTTP 400: query is not a mutation" });
  fwd.onMutation({ query: MUT, variables: { board: PSO }, data: {} });
  f.answers.push({ status: 401, json: { error: { message: "bad key" } } });
  const r = await fwd.tick();
  assert.equal(r.retry, true); assert.equal(r.in, AUTH_RETRY_MS);
  assert.equal(f.alerts.at(-1).title, "svc: Friday refused this service's key");
  fwd.advance(AUTH_RETRY_MS);
  f.answers.push({ throw: "fetch failed" });
  const r2 = await fwd.tick();
  assert.equal(r2.retry, true); assert.equal(r2.error, "no answer: fetch failed");
  fwd.advance(r2.in);
  assert.equal((await fwd.tick()).done, true);
  assert.equal(fwd.queue.length, 0);
});

test("the alert is throttled to one an hour per kind, and a failing alert never throws", async () => {
  const f = fakeFriday(); f.alerts = [];
  const fwd = make(f);
  for (let i = 0; i < 3; i++) { fwd.onMutation({ query: MUT, variables: { board: PSO }, data: {} }); f.answers.push({ status: 400, json: {} }); await fwd.tick(); }
  assert.equal(f.alerts.length, 1);
  fwd.advance(3_600_001);
  fwd.onMutation({ query: MUT, variables: { board: PSO }, data: {} }); f.answers.push({ status: 400, json: {} }); await fwd.tick();
  assert.equal(f.alerts.length, 2);
  const g = fakeFriday();
  const noisy = createFridayForward({ env, log: () => {}, alert: async () => { throw new Error("ntfy down"); }, fetchImpl: g.impl, service: "svc" });
  noisy.stop();
  noisy.onMutation({ query: MUT, variables: { board: PSO }, data: {} }); g.answers.push({ status: 400, json: {} });
  assert.equal((await noisy.tick()).dead, true);
});

test("onMutation and onFile never throw, whatever they are handed; an oversized file is skipped", async () => {
  const f = fakeFriday();
  const fwd = make(f);
  assert.equal(fwd.onMutation(), false);
  assert.equal(fwd.onMutation({ query: null, variables: "nope" }), false);
  assert.equal(fwd.onFile(), false);
  assert.equal(fwd.onFile({ itemId: "1", column: "file_x", bytes: Buffer.alloc(0) }), false);
  assert.equal(fwd.onFile({ itemId: "1", column: "file_x", bytes: Buffer.alloc(25 * 1024 * 1024 + 1) }), false);
  assert.equal(fwd.queue.length, 0);
});
