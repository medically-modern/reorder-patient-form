// GET /api/oop-estimate — the response shape and the column fallback, with the Stedi
// backend call and the Monday read both mocked. No network, no real rows.
const test = require("node:test");
const assert = require("node:assert/strict");

const { COLUMNS } = require("../src/config");
const { readBenefitsSnapshot, fetchBackendEstimate, FLAGS_SNAPSHOT } = require("../src/oopEstimator");
const { buildOopEstimateResponse, parseInfusionSetsParam, displayText } = require("../src/oopEstimateRoute");

const quiet = { warn() {}, log() {} };

const SHAPE_KEYS = [
  "ok", "source", "kind", "text", "low", "high", "patientPaysNothing", "zeroReason",
  "confidence", "flags", "flagText", "needsBenefits", "quantityAware", "present",
];

function assertShape(res) {
  for (const k of SHAPE_KEYS) assert.ok(k in res, `missing ${k}`);
  assert.ok(Array.isArray(res.flags));
  assert.ok(Array.isArray(res.flagText));
  assert.ok(Array.isArray(res.needsBenefits));
}

// A readColumns mock that returns the parsed snapshot of a row given as {columnId: text}.
const columnsOf = (row) => async () => readBenefitsSnapshot(row);
const noColumns = async () => { throw new Error("Monday must not be read when the backend answered"); };

// A fetchEstimate mock built from the real fetchBackendEstimate over a fake fetch, so
// the route is tested against the real normalisation of the backend's JSON.
function backendReturning(body, status = 200) {
  const fetch = async () => ({ ok: status < 300, status, json: async () => body });
  return (args) => fetchBackendEstimate(args, { url: "https://stedi-backend.test", adminKey: "k", timeoutMs: 1000, fetch });
}
const backendDown = (args) => fetchBackendEstimate(args, { url: "https://stedi-backend.test", adminKey: "k", timeoutMs: 1000, fetch: async () => { throw new TypeError("fetch failed"); } });
const backendUnconfigured = (args) => fetchBackendEstimate(args, { url: "", adminKey: "", timeoutMs: 1000 });

function body(overrides) {
  return {
    first_order: null, first_order_no_monitor: null,
    recurring: { low: 61.2, high: 61.2, text: "61.20" },
    patient_pays_nothing: false, zero_reason: "", confidence: "High", flags: [], flag_text: [],
    needs_benefits: [], lines: [], snapshot_present: true, primary_label: "Example Payer", serving: "Pump & Supplies",
    ...overrides,
  };
}

test("backend priced it → source backend, amount, quantity-aware, Monday not read", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456", infusionSets: 6, fetchEstimate: backendReturning(body()), readColumns: noColumns, log: quiet,
  });
  assertShape(res);
  assert.equal(res.ok, true);
  assert.equal(res.source, "backend");
  assert.equal(res.kind, "amount");
  assert.equal(res.text, "$61.20");
  assert.equal(res.low, 61.2);
  assert.equal(res.high, 61.2);
  assert.equal(res.patientPaysNothing, false);
  assert.equal(res.confidence, "");                       // rep-facing — stripped from the public route
  assert.equal(res.quantityAware, true);
  assert.equal(res.present, true);
});

test("backend range → '$low–$high' with the flag that caused it", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456", infusionSets: 3,
    fetchEstimate: backendReturning(body({
      recurring: { low: 61.2, high: 142.8, text: "61.20-142.80" }, confidence: "Low",
      flags: ["COINSURANCE_AMBIGUOUS"], flag_text: [FLAGS_SNAPSHOT.flags.COINSURANCE_AMBIGUOUS.text],
    })),
    readColumns: noColumns, log: quiet,
  });
  assert.equal(res.kind, "range");
  assert.equal(res.text, "$61.20–$142.80");
  assert.equal(res.confidence, "");
  assert.deepEqual(res.flags, []);                           // flags never reach the patient (Brandon 2026-10-07)
  assert.deepEqual(res.flagText, []);
});

test("backend says patient pays nothing → '$0' + zero reason", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456",
    fetchEstimate: backendReturning(body({
      recurring: null, patient_pays_nothing: true, zero_reason: "Qualified Medicare Beneficiary — patient cannot be billed",
      flags: ["QMB"], flag_text: [FLAGS_SNAPSHOT.flags.QMB.text],
    })),
    readColumns: noColumns, log: quiet,
  });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "zero");
  assert.equal(res.text, "$0");
  assert.equal(res.patientPaysNothing, true);
  assert.equal(res.zeroReason, "");                        // the page says "Your plan covers these supplies in full."
});

test("backend answered 'need benefits' → rendered as such from the backend, NOT a column fallback", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456",
    fetchEstimate: backendReturning(body({
      recurring: null, needs_benefits: ["coinsurance", "deductible"], confidence: "Low",
      flags: ["COINSURANCE_MISSING"], flag_text: [FLAGS_SNAPSHOT.flags.COINSURANCE_MISSING.text],
    })),
    readColumns: noColumns, log: quiet,
  });
  assert.equal(res.ok, true);
  assert.equal(res.source, "backend");
  assert.equal(res.kind, "needBenefits");
  assert.equal(res.text, "Need benefits");
  assert.equal(res.low, null);
  assert.equal(res.high, null);
  assert.deepEqual(res.needsBenefits, []);                   // internal tokens stay internal
  assert.equal(res.confidence, "");
});

test("backend unreachable → falls back to the OOP Estimate column, source 'column', not quantity-aware", async () => {
  const warnings = [];
  const res = await buildOopEstimateResponse({
    itemId: "123456", infusionSets: 6,
    fetchEstimate: backendDown,
    readColumns: columnsOf({
      [COLUMNS.OOP_ESTIMATE]: "$61.20",
      [COLUMNS.BNF_CONFIDENCE]: "Medium",
      [COLUMNS.BNF_FLAGS]: "COINSURANCE_PLAN_LEVEL",
      [COLUMNS.BNF_VERSION]: "br-2026.10.07.1",
    }),
    log: { warn: (m) => warnings.push(m), log() {} },
  });
  assertShape(res);
  assert.equal(res.ok, true);
  assert.equal(res.source, "column");
  assert.equal(res.kind, "amount");
  assert.equal(res.text, "$61.20");
  assert.equal(res.low, 61.2);
  assert.equal(res.confidence, "");
  assert.deepEqual(res.flagText, []);
  assert.equal(res.quantityAware, false);
  assert.equal(res.present, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unreachable/);
});

test("backend not configured → column fallback too", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456", fetchEstimate: backendUnconfigured,
    readColumns: columnsOf({ [COLUMNS.OOP_ESTIMATE]: "$228.75-$533.75", [COLUMNS.BNF_VERSION]: "br-2026.10.07.1" }), log: quiet,
  });
  assert.equal(res.source, "column");
  assert.equal(res.kind, "range");
  assert.equal(res.text, "$228.75–$533.75");
});

test("backend 5xx → column fallback", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456", fetchEstimate: backendReturning({ detail: "boom" }, 500),
    readColumns: columnsOf({ [COLUMNS.OOP_ESTIMATE]: "$0.00", [COLUMNS.BNF_VERSION]: "br-2026.10.07.1" }), log: quiet,
  });
  assert.equal(res.source, "column");
  assert.equal(res.kind, "amount");
  assert.equal(res.text, "$0.00");
  assert.equal(res.patientPaysNothing, false);
});

test("column fallback: '$0' is a who-pays zero and the note is the reason", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456", fetchEstimate: backendDown,
    readColumns: columnsOf({
      [COLUMNS.OOP_ESTIMATE]: "$0",
      [COLUMNS.BNF_OOP_NOTE]: "Secondary NY Medicaid covers the primary's cost share",
      [COLUMNS.BNF_VERSION]: "br-2026.10.07.1",
    }), log: quiet,
  });
  assert.equal(res.kind, "zero");
  assert.equal(res.text, "$0");
  assert.equal(res.patientPaysNothing, true);
  assert.equal(res.zeroReason, "");
});

test("column fallback: 'Need benefits' carries the note's missing list", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456", fetchEstimate: backendDown,
    readColumns: columnsOf({
      [COLUMNS.OOP_ESTIMATE]: "Need benefits",
      [COLUMNS.BNF_OOP_NOTE]: "missing: coinsurance",
      [COLUMNS.BNF_VERSION]: "br-2026.10.07.1",
    }), log: quiet,
  });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "needBenefits");
  assert.deepEqual(res.needsBenefits, []);                   // stripped on the public route
});

test("column fallback: a row the backend has not written → ok:false, blank, never $0", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456", fetchEstimate: backendDown, readColumns: columnsOf({}), log: quiet,
  });
  assertShape(res);
  assert.equal(res.ok, false);
  assert.equal(res.kind, "unwritten");
  assert.equal(res.text, "");
  assert.equal(res.low, null);
  assert.equal(res.patientPaysNothing, false);
  assert.equal(res.present, false);
});

test("column fallback: the retired estimator's 'Error: …' text is treated as unwritten", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456", fetchEstimate: backendDown,
    readColumns: columnsOf({ [COLUMNS.OOP_ESTIMATE]: "Error: No rate schedule for \"X\"" }), log: quiet,
  });
  assert.equal(res.ok, false);
  assert.equal(res.kind, "unwritten");
});

test("column fallback: row not found → notFound", async () => {
  const res = await buildOopEstimateResponse({
    itemId: "123456", fetchEstimate: backendDown, readColumns: async () => null, log: quiet,
  });
  assert.deepEqual(res, { notFound: true });
});

test("the quantity from the form is passed through to the backend call", async () => {
  let seen = null;
  const res = await buildOopEstimateResponse({
    itemId: "123456", infusionSets: 9,
    fetchEstimate: async (args) => { seen = args; return { ok: true, estimate: { low: 1, high: 1, text: "1.00" }, patientPaysNothing: false, flags: [], flagText: [], needsBenefits: [], confidence: "High", snapshotPresent: true }; },
    readColumns: noColumns, log: quiet,
  });
  assert.deepEqual(seen, { itemId: "123456", infusionSets: 9 });
  assert.equal(res.text, "$1.00");
});

test("parseInfusionSetsParam: integers 1–9 pass, anything else means 'not given'", () => {
  assert.equal(parseInfusionSetsParam("3"), 3);
  assert.equal(parseInfusionSetsParam("9"), 9);
  assert.equal(parseInfusionSetsParam("1"), 1);
  assert.equal(parseInfusionSetsParam("0"), undefined);
  assert.equal(parseInfusionSetsParam("10"), undefined);
  assert.equal(parseInfusionSetsParam("-2"), undefined);
  assert.equal(parseInfusionSetsParam("abc"), undefined);
  assert.equal(parseInfusionSetsParam(""), undefined);
  assert.equal(parseInfusionSetsParam(undefined), undefined);
  assert.equal(parseInfusionSetsParam(["3", "4"]), undefined);
});

test("displayText renders each kind", () => {
  assert.equal(displayText({ kind: "amount", low: 5, high: 5 }), "$5.00");
  assert.equal(displayText({ kind: "range", low: 5, high: 10.5 }), "$5.00–$10.50");
  assert.equal(displayText({ kind: "zero", low: 0, high: 0 }), "$0");
  assert.equal(displayText({ kind: "needBenefits" }), "Need benefits");
  assert.equal(displayText({ kind: "unwritten" }), "");
});

// ── Patient-facing safety (Brandon 2026-10-07): no internal wording, and nothing at all
// for an internal-only payer or a check that ran under the wrong payer.
test("internal-only payer (Horizon) → the card is hidden, no figure leaks", async () => {
  const backend = async () => ({ ok: true, estimate: { low: 61.2, high: 61.2, text: "61.20" }, patientPaysNothing: false, confidence: "High",
    flags: ["DO_NOT_SHARE_WITH_PATIENT"], flagText: ["x"], needsBenefits: [], zeroReason: "", snapshotPresent: true, patientVisible: false, wrongPayer: "" });
  const res = await buildOopEstimateResponse({ itemId: "1", fetchEstimate: backend, readColumns: async () => null, log: quiet });
  assert.equal(res.ok, false);
  assert.equal(res.hidden, true);
  assert.equal(res.kind, "hidden");
  assert.equal(res.text, "");
  assert.equal(res.low, null);
  assert.deepEqual(res.flags, []);
});

test("wrong-payer check → hidden too (the re-run populates the figure)", async () => {
  const backend = async () => ({ ok: false, reason: "need benefits", patientPaysNothing: false, confidence: "Low", flags: ["WRONG_PAYER"], flagText: ["x"],
    needsBenefits: ["wrong payer — re-run under Humana"], zeroReason: "", snapshotPresent: true, patientVisible: true, wrongPayer: "Humana" });
  const res = await buildOopEstimateResponse({ itemId: "1", fetchEstimate: backend, readColumns: async () => null, log: quiet });
  assert.equal(res.hidden, true);
  assert.deepEqual(res.needsBenefits, []);
});

test("column fallback with an internal-only flag in the dropdown is hidden as well", async () => {
  const row = { [COLUMNS.OOP_ESTIMATE]: "$61.20", [COLUMNS.BNF_VERSION]: "br-test",
    [COLUMNS.BNF_FLAGS]: "DO_NOT_SHARE_WITH_PATIENT", [COLUMNS.BNF_CONFIDENCE]: "High" };
  const res = await buildOopEstimateResponse({ itemId: "1", fetchEstimate: async () => ({ ok: false, unavailable: true, reason: "down" }), readColumns: columnsOf(row), log: quiet });
  assert.equal(res.hidden, true);
  assert.equal(res.text, "");
});

test("every public response is patient-safe: no confidence, flags, reasons or missing-input tokens", async () => {
  const backend = async () => ({ ok: true, estimate: { low: 1, high: 2, text: "1.00-2.00" }, patientPaysNothing: false, confidence: "Low",
    flags: ["TIER_UNVERIFIED"], flagText: ["t"], needsBenefits: ["x"], zeroReason: "internal", snapshotPresent: true, patientVisible: true, wrongPayer: "" });
  const res = await buildOopEstimateResponse({ itemId: "1", fetchEstimate: backend, readColumns: async () => null, log: quiet });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "range");
  assert.equal(res.confidence, "");
  assert.deepEqual(res.flags, []);
  assert.deepEqual(res.flagText, []);
  assert.deepEqual(res.needsBenefits, []);
  assert.equal(res.zeroReason, "");
});
