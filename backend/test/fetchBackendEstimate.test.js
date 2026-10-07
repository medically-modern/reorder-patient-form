// fetchBackendEstimate — POST {STEDI_BACKEND_URL}/oop/estimate with a mocked fetch.
// No network, no real item ids.
const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchBackendEstimate, FLAGS_SNAPSHOT } = require("../src/oopEstimator");

const CFG = { url: "https://stedi-backend.test", adminKey: "test-admin-key", timeoutMs: 6000 };

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function okBody(overrides = {}) {
  return {
    first_order: { low: 228.75, high: 228.75, text: "228.75" },
    first_order_no_monitor: { low: 100, high: 100, text: "100.00" },
    recurring: { low: 61.2, high: 61.2, text: "61.20" },
    patient_pays_nothing: false,
    zero_reason: "",
    confidence: "High",
    flags: [],
    flag_text: [],
    needs_benefits: [],
    lines: [],
    snapshot_present: true,
    primary_label: "Example Payer",
    serving: "CGM & Pump & Supplies",
    ...overrides,
  };
}

test("sends the contract's request: POST /oop/estimate, X-Admin-Key, board/item/quantities", async () => {
  let seen = null;
  const fetch = async (url, init) => { seen = { url, init }; return jsonResponse(okBody()); };

  const out = await fetchBackendEstimate({ itemId: "123456", infusionSets: 6, sensorsPerFill: 3 }, { ...CFG, fetch });

  assert.equal(out.ok, true);
  assert.equal(seen.url, "https://stedi-backend.test/oop/estimate");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["X-Admin-Key"], "test-admin-key");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(seen.init.body), { board: "subscription", item_id: "123456", infusion_sets: 6, sensors_per_fill: 3 });
  assert.ok(seen.init.signal, "an AbortSignal is attached for the timeout");
});

test("omits quantities that were not given, so the backend uses the row's own", async () => {
  let body = null;
  const fetch = async (url, init) => { body = JSON.parse(init.body); return jsonResponse(okBody()); };
  await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, fetch });
  assert.deepEqual(body, { board: "subscription", item_id: "123456" });
});

test("a priced answer returns the recurring estimate with confidence and flags", async () => {
  const fetch = async () => jsonResponse(okBody({
    recurring: { low: 61.2, high: 98.4, text: "61.20-98.40" },
    confidence: "Low",
    flags: ["COINSURANCE_AMBIGUOUS"],
    flag_text: [FLAGS_SNAPSHOT.flags.COINSURANCE_AMBIGUOUS.text],
  }));
  const out = await fetchBackendEstimate({ itemId: "123456", infusionSets: 3 }, { ...CFG, fetch });
  assert.equal(out.ok, true);
  assert.deepEqual(out.estimate, { low: 61.2, high: 98.4, text: "61.20-98.40" });
  assert.equal(out.patientPaysNothing, false);
  assert.equal(out.confidence, "Low");
  assert.deepEqual(out.flags, ["COINSURANCE_AMBIGUOUS"]);
  assert.deepEqual(out.flagText, [FLAGS_SNAPSHOT.flags.COINSURANCE_AMBIGUOUS.text]);
  assert.equal(out.snapshotPresent, true);
  assert.equal(out.unavailable, undefined);
});

test("flag text is filled from the snapshot when the backend sends codes only", async () => {
  const fetch = async () => jsonResponse(okBody({ flags: ["QMB", "COPAY_PLAN"], flag_text: [] }));
  const out = await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, fetch });
  assert.deepEqual(out.flagText, [FLAGS_SNAPSHOT.flags.QMB.text, FLAGS_SNAPSHOT.flags.COPAY_PLAN.text]);
});

test("`money` selects first_order / first_order_no_monitor instead of recurring", async () => {
  const fetch = async () => jsonResponse(okBody());
  const first = await fetchBackendEstimate({ itemId: "123456", money: "firstOrder" }, { ...CFG, fetch });
  const noMon = await fetchBackendEstimate({ itemId: "123456", money: "firstOrderNoMonitor" }, { ...CFG, fetch });
  assert.equal(first.estimate.low, 228.75);
  assert.equal(noMon.estimate.low, 100);
});

test("patient_pays_nothing → ok with a $0 estimate and the zero reason", async () => {
  const fetch = async () => jsonResponse(okBody({
    recurring: null, first_order: null, first_order_no_monitor: null,
    patient_pays_nothing: true, zero_reason: "Primary insurance is a Medicaid product — no patient cost share",
    flags: ["PRIMARY_MEDICAID"], flag_text: [FLAGS_SNAPSHOT.flags.PRIMARY_MEDICAID.text],
  }));
  const out = await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, fetch });
  assert.equal(out.ok, true);
  assert.equal(out.patientPaysNothing, true);
  assert.deepEqual(out.estimate, { low: 0, high: 0, text: "$0" });
  assert.match(out.zeroReason, /Medicaid/);
});

test("a null money field → clean {ok:false, reason:'need benefits'} that is NOT 'unavailable'", async () => {
  const fetch = async () => jsonResponse(okBody({
    recurring: null, patient_pays_nothing: false,
    needs_benefits: ["coinsurance"], confidence: "Low", flags: ["COINSURANCE_MISSING"],
    flag_text: [FLAGS_SNAPSHOT.flags.COINSURANCE_MISSING.text],
  }));
  const out = await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, fetch });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "need benefits");
  assert.equal(out.unavailable, undefined);
  assert.deepEqual(out.needsBenefits, ["coinsurance"]);
  assert.equal(out.confidence, "Low");
  assert.deepEqual(out.flags, ["COINSURANCE_MISSING"]);
});

test("a money field with non-numeric low/high counts as null", async () => {
  const fetch = async () => jsonResponse(okBody({ recurring: { low: null, high: null, text: "" } }));
  const out = await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, fetch });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "need benefits");
});

test("unreachable backend → {ok:false, reason, unavailable:true}", async () => {
  const fetch = async () => { throw new TypeError("fetch failed"); };
  const out = await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, fetch });
  assert.equal(out.ok, false);
  assert.equal(out.unavailable, true);
  assert.match(out.reason, /unreachable: fetch failed/);
});

test("times out: the AbortSignal fires and the result is a clean failure", async () => {
  const fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
  const started = Date.now();
  const out = await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, timeoutMs: 25, fetch });
  assert.equal(out.ok, false);
  assert.equal(out.unavailable, true);
  assert.match(out.reason, /timeout after 25ms/);
  assert.ok(Date.now() - started < 2000, "did not wait for the real 6s default");
});

test("non-2xx → unavailable with the status in the reason", async () => {
  const fetch = async () => jsonResponse({ detail: "boom" }, 503);
  const out = await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, fetch });
  assert.equal(out.ok, false);
  assert.equal(out.unavailable, true);
  assert.equal(out.reason, "http 503");
});

test("malformed JSON → unavailable", async () => {
  const fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } });
  const out = await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, fetch });
  assert.equal(out.ok, false);
  assert.equal(out.unavailable, true);
  assert.equal(out.reason, "malformed response");
});

test("not configured (no URL / no key) → unavailable without calling fetch", async () => {
  let called = 0;
  const fetch = async () => { called++; return jsonResponse(okBody()); };
  const noUrl = await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, url: "", fetch });
  const noKey = await fetchBackendEstimate({ itemId: "123456" }, { ...CFG, adminKey: "", fetch });
  assert.equal(noUrl.ok, false);
  assert.equal(noUrl.unavailable, true);
  assert.equal(noUrl.reason, "not configured");
  assert.equal(noKey.reason, "not configured");
  assert.equal(called, 0);
});

test("reads STEDI_BACKEND_URL / STEDI_ADMIN_KEY from the environment when no override is given", async () => {
  const prev = { url: process.env.STEDI_BACKEND_URL, key: process.env.STEDI_ADMIN_KEY };
  process.env.STEDI_BACKEND_URL = "https://env-backend.test/";   // trailing slash is trimmed
  process.env.STEDI_ADMIN_KEY = "env-key";
  try {
    let seen = null;
    const fetch = async (url, init) => { seen = { url, init }; return jsonResponse(okBody()); };
    const out = await fetchBackendEstimate({ itemId: "123456" }, { fetch });
    assert.equal(out.ok, true);
    assert.equal(seen.url, "https://env-backend.test/oop/estimate");
    assert.equal(seen.init.headers["X-Admin-Key"], "env-key");
  } finally {
    if (prev.url === undefined) delete process.env.STEDI_BACKEND_URL; else process.env.STEDI_BACKEND_URL = prev.url;
    if (prev.key === undefined) delete process.env.STEDI_ADMIN_KEY; else process.env.STEDI_ADMIN_KEY = prev.key;
  }
});

test("a non-numeric item id never reaches the backend", async () => {
  let called = 0;
  const fetch = async () => { called++; return jsonResponse(okBody()); };
  const out = await fetchBackendEstimate({ itemId: "abc" }, { ...CFG, fetch });
  assert.equal(out.ok, false);
  assert.equal(out.unavailable, true);
  assert.equal(called, 0);
});
