// GET /api/oop-estimate — the logic behind the route, kept out of index.js so it can
// be exercised with a mocked backend and a mocked Monday read (test/oopEstimateRoute.test.js).
//
// Order of preference:
//   1. The Stedi backend's POST /oop/estimate for this row and the patient's chosen
//      infusion-set quantity (source "backend"). The backend's answer is final even
//      when it is "Need benefits" — the Monday column was written by the same code and
//      cannot know more.
//   2. Only when the backend is UNAVAILABLE (not configured, timeout, network, non-2xx,
//      malformed): the OOP Estimate column (text_mm404p7d) the backend last wrote,
//      parsed with parseEstimateText (source "column"). That number is the row's stored
//      quantity, not the one on the form, so `quantityAware` is false.
//
// Response (every field always present):
//   ok                 true when there is something to show — an amount, a range, $0 or
//                      "Need benefits"; false when the row has nothing yet (kind "unwritten")
//   source             "backend" | "column"
//   kind               "amount" | "range" | "zero" | "needBenefits" | "unwritten"
//   text               "$228.75" | "$228.75–$533.75" | "$0" | "Need benefits" | ""
//   low, high          numbers, or null when unknown
//   patientPaysNothing true only for kind "zero" (a who-pays rule); never inferred from blank
//   zeroReason         the backend's reason / the column note, for the "$0" line
//   confidence         "High" | "Medium" | "Low" | ""
//   flags, flagText    parallel arrays — codes and their text (benefitsFlags.json)
//   needsBenefits      inputs the backend still needs (kind "needBenefits")
//   quantityAware      whether `text` reflects the quantity the form asked about
//   present            whether the backend has resolved this row at all

const { missingFromNote } = require("./oopEstimator");

const MIN_INFUSION_SETS = 1;
const MAX_INFUSION_SETS = 9; // the form's own cap (Anthem Commercial / Horizon allow 9)

// Query-string → integer or undefined. Out-of-range or garbage is treated as "not
// given" rather than an error: the backend then uses the row's stored quantity.
function parseInfusionSetsParam(raw) {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined; // ?a=1&a=2 arrives as an array
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < MIN_INFUSION_SETS || n > MAX_INFUSION_SETS) return undefined;
  return n;
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

// Text for the card from a parsed estimate ({kind, low, high}). Ranges use an en dash
// (reader contract: "$low–$high").
function displayText(parsed) {
  switch (parsed.kind) {
    case "amount": return money(parsed.low);
    case "range": return `${money(parsed.low)}–${money(parsed.high)}`;
    case "zero": return "$0";
    case "needBenefits": return "Need benefits";
    default: return "";
  }
}

function base(fields) {
  return {
    ok: false,
    source: "column",
    kind: "unwritten",
    text: "",
    low: null,
    high: null,
    patientPaysNothing: false,
    zeroReason: "",
    confidence: "",
    flags: [],
    flagText: [],
    needsBenefits: [],
    quantityAware: false,
    present: false,
    ...fields,
  };
}

function fromBackend(result) {
  const common = {
    source: "backend",
    confidence: result.confidence || "",
    flags: result.flags || [],
    flagText: result.flagText || [],
    needsBenefits: result.needsBenefits || [],
    zeroReason: result.zeroReason || "",
    quantityAware: true,
    present: result.snapshotPresent === true,
  };

  if (result.ok && result.patientPaysNothing) {
    return base({ ...common, ok: true, kind: "zero", text: "$0", low: 0, high: 0, patientPaysNothing: true });
  }
  if (result.ok) {
    const { low, high } = result.estimate;
    const parsed = low === high ? { kind: "amount", low, high } : { kind: "range", low, high };
    return base({ ...common, ok: true, kind: parsed.kind, text: displayText(parsed), low, high });
  }
  // The backend answered but could not price it: an input is unknown.
  return base({ ...common, ok: true, kind: "needBenefits", text: "Need benefits" });
}

function fromColumn(snapshot) {
  const parsed = snapshot.recurring;
  const common = {
    source: "column",
    confidence: snapshot.confidence || "",
    flags: snapshot.flags || [],
    flagText: snapshot.flagText || [],
    zeroReason: parsed.kind === "zero" ? (snapshot.note || "") : "",
    needsBenefits: parsed.kind === "needBenefits" ? missingFromNote(snapshot.note) : [],
    quantityAware: false,
    present: snapshot.present === true,
  };
  return base({
    ...common,
    ok: parsed.kind !== "unwritten",
    kind: parsed.kind,
    text: displayText(parsed),
    low: parsed.low,
    high: parsed.high,
    patientPaysNothing: parsed.kind === "zero",
  });
}

// `fetchEstimate` is oopEstimator.fetchBackendEstimate and `readColumns` is
// monday.getOopEstimateColumns; both are injected so tests can mock them.
async function buildOopEstimateResponse({ itemId, infusionSets, fetchEstimate, readColumns, log = console }) {
  const backend = await fetchEstimate({ itemId, infusionSets });
  if (!backend.unavailable) {
    return fromBackend(backend);
  }

  log.warn(`[oop-estimate] Stedi backend unavailable (${backend.reason}) — falling back to the OOP Estimate column for item ${itemId}`);
  const snapshot = await readColumns(itemId);
  if (!snapshot) return { notFound: true };
  return fromColumn(snapshot);
}

module.exports = {
  buildOopEstimateResponse,
  parseInfusionSetsParam,
  displayText,
  MAX_INFUSION_SETS,
};
