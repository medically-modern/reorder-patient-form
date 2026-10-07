// readBenefitsSnapshot — the Subscription board's benefits columns → one object.
// Column ids come from config.js (COLUMNS.BNF_* and OOP_ESTIMATE). No patient data here.
const test = require("node:test");
const assert = require("node:assert/strict");

const { COLUMNS } = require("../src/config");
const { readBenefitsSnapshot, parseFlagCodes, flagText, normalizeConfidence, missingFromNote, FLAGS_SNAPSHOT } = require("../src/oopEstimator");

const RESOLVED_ROW = {
  [COLUMNS.OOP_ESTIMATE]:   "$61.20",
  [COLUMNS.BNF_FIRST_WMON]: "$228.75-$533.75",
  [COLUMNS.BNF_CONFIDENCE]: "Medium",
  [COLUMNS.BNF_FLAGS]:      "COINSURANCE_PLAN_LEVEL, DEDUCTIBLE_FAMILY_FALLBACK",
  [COLUMNS.BNF_OOP_NOTE]:   "plan-level coinsurance used",
  [COLUMNS.BNF_VERSION]:    "br-2026.10.07.1",
};

test("column ids match the reader contract", () => {
  assert.equal(COLUMNS.OOP_ESTIMATE, "text_mm404p7d");        // Subscription board's Recurring OOP
  assert.equal(COLUMNS.BNF_FIRST_WMON, "text_bnf_first_wmon");
  assert.equal(COLUMNS.BNF_CONFIDENCE, "color_bnf_confidence");
  assert.equal(COLUMNS.BNF_OOP_CONF, "text_bnf_oop_conf");
  assert.equal(COLUMNS.BNF_FLAGS, "dropdown_bnf_flags");
  assert.equal(COLUMNS.BNF_OOP_NOTE, "text_bnf_oop_note");
  assert.equal(COLUMNS.BNF_VERSION, "text_bnf_version");
  assert.equal(COLUMNS.BNF_COINS_CGM, "text_bnf_coins_cgm");
  assert.equal(COLUMNS.BNF_COINS_DME, "text_bnf_coins_dme");
  assert.equal(COLUMNS.BNF_COPAY_CGM, "text_bnf_copay_cgm");
  assert.equal(COLUMNS.BNF_COPAY_DME, "text_bnf_copay_dme");
  assert.equal(COLUMNS.BNF_CANDIDATES, "text_bnf_candidates");
  assert.equal(COLUMNS.BNF_DED_USED, "text_bnf_ded_used");
  assert.equal(COLUMNS.BNF_DED_LEVEL, "text_bnf_ded_level");
  assert.equal(COLUMNS.BNF_OOP_USED, "text_bnf_oop_used");
  assert.equal(COLUMNS.BNF_OOP_LEVEL, "text_bnf_oop_level");
  assert.equal(COLUMNS.BNF_REASONS, "text_bnf_reasons");
  assert.equal(COLUMNS.BNF_OOP_LINES, "text_bnf_oop_lines");
});

test("a resolved row reads back as parsed estimates, confidence, flags with text, note and version", () => {
  const snap = readBenefitsSnapshot(RESOLVED_ROW);
  assert.equal(snap.present, true);
  assert.equal(snap.version, "br-2026.10.07.1");
  assert.deepEqual(snap.recurring, { kind: "amount", low: 61.2, high: 61.2, text: "$61.20" });
  assert.deepEqual(snap.firstOrder, { kind: "range", low: 228.75, high: 533.75, text: "$228.75-$533.75" });
  assert.equal(snap.confidence, "Medium");
  assert.deepEqual(snap.flags, ["COINSURANCE_PLAN_LEVEL", "DEDUCTIBLE_FAMILY_FALLBACK"]);
  assert.deepEqual(snap.flagText, [
    FLAGS_SNAPSHOT.flags.COINSURANCE_PLAN_LEVEL.text,
    FLAGS_SNAPSHOT.flags.DEDUCTIBLE_FAMILY_FALLBACK.text,
  ]);
  assert.equal(snap.note, "plan-level coinsurance used");
});

test("accepts Monday's column_values array and a col(id) reader as well as a plain object", () => {
  const asArray = Object.entries(RESOLVED_ROW).map(([id, text]) => ({ id, text, type: "text", value: null }));
  const asReader = (id) => RESOLVED_ROW[id] || "";
  assert.deepEqual(readBenefitsSnapshot(asArray), readBenefitsSnapshot(RESOLVED_ROW));
  assert.deepEqual(readBenefitsSnapshot(asReader), readBenefitsSnapshot(RESOLVED_ROW));
});

test("an unresolved row (blank version) is present:false and every estimate is unwritten — never $0", () => {
  const snap = readBenefitsSnapshot({});
  assert.equal(snap.present, false);
  assert.equal(snap.version, "");
  assert.equal(snap.recurring.kind, "unwritten");
  assert.equal(snap.recurring.low, null);
  assert.equal(snap.firstOrder.kind, "unwritten");
  assert.equal(snap.confidence, "");
  assert.deepEqual(snap.flags, []);
  assert.deepEqual(snap.flagText, []);
  assert.equal(snap.note, "");
});

test("a Monday null text is treated as blank", () => {
  const snap = readBenefitsSnapshot([{ id: COLUMNS.OOP_ESTIMATE, text: null }, { id: COLUMNS.BNF_VERSION, text: null }]);
  assert.equal(snap.present, false);
  assert.equal(snap.recurring.kind, "unwritten");
});

test("'$0' recurring with a note is a who-pays zero, and the note is the reason", () => {
  const snap = readBenefitsSnapshot({
    [COLUMNS.OOP_ESTIMATE]: "$0",
    [COLUMNS.BNF_OOP_NOTE]: "Primary insurance is a Medicaid product — no patient cost share",
    [COLUMNS.BNF_VERSION]: "br-2026.10.07.1",
    [COLUMNS.BNF_FLAGS]: "PRIMARY_MEDICAID",
    [COLUMNS.BNF_CONFIDENCE]: "High",
  });
  assert.equal(snap.recurring.kind, "zero");
  assert.match(snap.note, /Medicaid/);
  assert.deepEqual(snap.flagText, [FLAGS_SNAPSHOT.flags.PRIMARY_MEDICAID.text]);
});

test("the estimate's own confidence (OOP Est Confidence) wins over the resolution's", () => {
  const snap = readBenefitsSnapshot({ ...RESOLVED_ROW, [COLUMNS.BNF_CONFIDENCE]: "Low", [COLUMNS.BNF_OOP_CONF]: "High" });
  assert.equal(snap.confidence, "High");
  const older = readBenefitsSnapshot({ ...RESOLVED_ROW, [COLUMNS.BNF_OOP_CONF]: "" });
  assert.equal(older.confidence, "Medium");          // a row written before the column existed
});

test("flag codes: comma/newline separated, de-duplicated, unknown codes kept verbatim", () => {
  assert.deepEqual(parseFlagCodes("QMB, COPAY_PLAN,QMB\nTIER_UNVERIFIED"), ["QMB", "COPAY_PLAN", "TIER_UNVERIFIED"]);
  assert.deepEqual(parseFlagCodes(""), []);
  assert.deepEqual(parseFlagCodes(null), []);
  assert.equal(flagText("QMB"), FLAGS_SNAPSHOT.flags.QMB.text);
  assert.equal(flagText("NOT_A_REAL_FLAG"), "NOT_A_REAL_FLAG");
});

test("every flag code the contract lists has text in the generated snapshot", () => {
  const contract = [
    "TIER_UNVERIFIED", "COINSURANCE_AMBIGUOUS", "COPAY_AMBIGUOUS", "POS_UNVERIFIED", "COINSURANCE_MISSING",
    "UHC_COSTSHARE_UNVERIFIED", "HUMANA_GROUP_PLAN_UNVERIFIED", "MA_PLAN_RESPONSE_NEEDED", "COVERAGE_INACTIVE",
    "DEDUCTIBLE_MISSING", "NO_BENEFIT_ROWS", "OUT_OF_NETWORK_ONLY", "BLUECARD_NO_DME_ROWS", "DUAL_MEDICAID_RESPONSE",
    "DEDUCTIBLE_INFERRED_ZERO", "DEDUCTIBLE_FAMILY_FALLBACK", "OOP_FAMILY_FALLBACK", "COINSURANCE_PLAN_LEVEL",
    "SUPPLEMENT_PLAN_LETTER_UNCONFIRMED", "COMMERCIAL_SECONDARY_PRESENT", "OOP_MISSING", "DEDUCTIBLE_REMAINING_DERIVED",
    "COPAY_PLAN", "COPAY_ONCE_PER_DOS", "COPAY_PROVIDER_TYPE_CONDITIONAL", "DISCLAIMER_ROW_IGNORED",
    "CARVEOUT_ROW_IGNORED", "QMB", "PAYER_RULE_APPLIED", "ZERO_OOP_PAYER", "PRIMARY_MEDICAID", "SECONDARY_MEDICAID_COVERS",
    "LABEL_MISMATCH", "EP_PUMP_UNVERIFIED",
  ];
  for (const code of contract) {
    assert.ok(FLAGS_SNAPSHOT.flags[code], `missing flag ${code}`);
    assert.ok(FLAGS_SNAPSHOT.flags[code].text.length > 0, `empty text for ${code}`);
    assert.ok(["Low", "Medium", "Info"].includes(FLAGS_SNAPSHOT.flags[code].confidence), `bad confidence for ${code}`);
  }
});

test("confidence is normalised to the contract's vocabulary", () => {
  assert.equal(normalizeConfidence("High"), "High");
  assert.equal(normalizeConfidence("medium"), "Medium");
  assert.equal(normalizeConfidence(" LOW "), "Low");
  assert.equal(normalizeConfidence(""), "");
  assert.equal(normalizeConfidence("Unknown"), "");
  assert.equal(normalizeConfidence(null), "");
});

test("missing inputs are read from the note's 'missing:' list", () => {
  assert.deepEqual(missingFromNote("Need benefits — missing: coinsurance, deductible"), ["coinsurance", "deductible"]);
  assert.deepEqual(missingFromNote("plan-level coinsurance used"), []);
  assert.deepEqual(missingFromNote(""), []);
});
