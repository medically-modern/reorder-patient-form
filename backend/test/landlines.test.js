// reportLandlines — notes the exact number on the item and emails the list. No network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { reportLandlines, formatPhone } = require("../src/landlines");

const L = [{ itemId: 111, uid: "U1", name: "Test Patient", phone: "+15555550123", errorCodes: ["SMS-CAR-411", "SMS-CAR-411"] }];
const env = { LANDLINE_EMAIL_TO: "a@example.com", EMAIL_FROM: "b@example.com", GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y", GOOGLE_REFRESH_TOKEN: "z" };

function stubs() {
  const s = { updates: [], alerts: [], sent: [] };
  s.columns = [];
  s.getStatusIndexMap = async () => ({ color_mm72jg9e: { yes: 1, no: 2 } });
  s.mondayQuery = async (q, v) => {
    if (q.includes("change_column_value")) { s.columns.push(v); return { change_column_value: { id: v.id } }; }
    s.updates.push(v); return { create_update: { id: "1" } };
  };
  s.notifyError = async (t, b) => { s.alerts.push(b); };
  s.fetch = async (url, opts) => {
    if (url.includes("oauth2")) return { ok: true, json: async () => ({ access_token: "t" }) };
    s.sent.push(Buffer.from(JSON.parse(opts.body).raw, "base64url").toString());
    return { ok: true };
  };
  return s;
}

test("notes the number that failed on the item and sends one email", async () => {
  const s = stubs();
  const r = await reportLandlines(L, { ...s, env });
  assert.equal(r.noted, 1);
  assert.equal(r.flagged, 1);
  assert.deepEqual(s.columns[0], { b: "18407459988", id: "111", c: "color_mm72jg9e", v: JSON.stringify({ index: 2 }) });
  assert.match(s.updates[0].body, /Can Text" set to No because of this number/);
  assert.equal(r.emailed, true);
  assert.equal(s.updates[0].id, "111");
  assert.match(s.updates[0].body, /\(555\) 555-0123/);
  assert.match(s.updates[0].body, /SMS-CAR-411/);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /Subject: Landline patients/);
  assert.equal(s.alerts.length, 0);
});

test("email not configured → the list goes to ntfy instead", async () => {
  const s = stubs();
  const r = await reportLandlines(L, { ...s, env: {} });
  assert.equal(r.emailed, false);
  assert.equal(s.sent.length, 0);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0], /Email NOT sent/);
});

test("formatPhone", () => {
  assert.equal(formatPhone("+15555550123"), "(555) 555-0123");
});

test("no \"No\" label on the live board → Can Text is not written, update still posted, ntfy says why", async () => {
  const s = stubs();
  s.getStatusIndexMap = async () => ({ color_mm72jg9e: { yes: 1 } });
  const r = await reportLandlines(L, { ...s, env });
  assert.equal(r.flagged, 0);
  assert.equal(s.columns.length, 0);
  assert.equal(r.noted, 1);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0], /no "No" label/);
});
