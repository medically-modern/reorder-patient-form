/**
 * oopEstimator.js — out-of-pocket estimate READER.
 *
 * Until 2026-10 this file and docs/oopEstimator.js were byte-identical mirrors of an
 * estimator: a rate table, a zero-OOP payer set, a Medicaid label set, the Humana split
 * and the deductible / coinsurance / OOP-max arithmetic. All of that now lives in ONE
 * place, the Stedi backend (medicallymodern1/stedi-monday-integration), which resolves
 * benefits from the 271, applies every payer rule, and writes the result to Monday.
 *
 * This module only reads what the backend produced:
 *   parseEstimateText(text)      — the estimate column's text → {kind, low, high, text}
 *   readBenefitsSnapshot(col)    — the Subscription board's benefits columns → one object
 *   fetchBackendEstimate(args)   — POST {STEDI_BACKEND_URL}/oop/estimate for a number the
 *                                  backend did not pre-compute (the patient changed a quantity)
 *   flagText(code)               — a flag code → its text, from the generated snapshot
 *
 * NO rate table, NO payer set, NO arithmetic belongs here. test/noMath.test.js fails if any
 * comes back. Patient-facing copy (what the form says next to the number) lives in
 * docs/app.js; this module never invents a dollar figure — blank is blank, not $0.
 */

const { COLUMNS, stediBackendConfig } = require("./config");
const FLAGS_SNAPSHOT = require("./benefitsFlags.json");

// ─── Estimate text ───
// Formats the backend writes (reader contract): "$228.75", "$228.75-$533.75", "$0",
// "$0.00", "Need benefits", "". Semantics:
//   "$0"            a who-pays rule (Medicaid, QMB, zero-OOP payer, covering secondary) → kind "zero"
//   "$0.00"         priced at zero (0% rows)                                            → kind "amount", 0
//   "Need benefits" an input is unknown                                                 → kind "needBenefits"
//   ""              the backend has not written this row yet                            → kind "unwritten"
// Anything unrecognised ("Error: …", "N/A" from the retired estimator) is "unwritten" with
// the raw text kept, so a caller can log it but never shows it as a number.

const MONEY_SRC = String.raw`\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;
const SINGLE_RE = new RegExp(`^${MONEY_SRC}$`);
const RANGE_RE = new RegExp(`^${MONEY_SRC}\\s*(?:-|–|—|to)\\s*${MONEY_SRC}$`, "i");

function toMoney(whole, cents) {
  const n = Number(`${String(whole).replace(/,/g, "")}.${(cents || "0").padEnd(2, "0")}`);
  return Number.isFinite(n) ? n : null;
}

function parseEstimateText(raw) {
  const text = raw == null ? "" : String(raw).trim();
  if (!text) return { kind: "unwritten", low: null, high: null, text: "" };

  if (/^need benefits$/i.test(text)) return { kind: "needBenefits", low: null, high: null, text };
  if (/^\$\s*0$/.test(text)) return { kind: "zero", low: 0, high: 0, text };

  const range = RANGE_RE.exec(text);
  if (range) {
    const low = toMoney(range[1], range[2]);
    const high = toMoney(range[3], range[4]);
    if (low !== null && high !== null) {
      return { kind: "range", low: Math.min(low, high), high: Math.max(low, high), text };
    }
  }

  const single = SINGLE_RE.exec(text);
  if (single) {
    const n = toMoney(single[1], single[2]);
    if (n !== null) return { kind: "amount", low: n, high: n, text };
  }

  // Text the retired in-repo estimator used to write; still on rows the backend has not
  // rewritten yet. "Incomplete benefits data" meant exactly what "Need benefits" means now.
  if (/^incomplete benefits/i.test(text)) return { kind: "needBenefits", low: null, high: null, text };

  return { kind: "unwritten", low: null, high: null, text };
}

// ─── Flags ───

function flagText(code) {
  const entry = FLAGS_SNAPSHOT.flags[code];
  return entry ? entry.text : code;
}

function flagConfidence(code) {
  const entry = FLAGS_SNAPSHOT.flags[code];
  return entry ? entry.confidence : null;
}

// Monday's dropdown `text` is the selected labels joined by ", ". Codes are upper snake
// case; anything else in the cell is kept verbatim so an unknown code still surfaces.
function parseFlagCodes(text) {
  if (text == null) return [];
  const seen = new Set();
  const out = [];
  for (const part of String(text).split(/[,\n;]+/)) {
    const code = part.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function normalizeConfidence(text) {
  const t = (text == null ? "" : String(text)).trim().toLowerCase();
  if (!t) return "";
  const match = FLAGS_SNAPSHOT.confidence.find((c) => c.toLowerCase() === t);
  return match || "";
}

// ─── Benefits snapshot ───
// `source` is whatever shape the caller has for one Monday item: the `col(id) → text`
// reader every monday.js function builds, an item's `column_values` array, or a plain
// {columnId: text} object.

function toColumnReader(source) {
  if (typeof source === "function") return (id) => source(id) ?? "";
  if (Array.isArray(source)) {
    const byId = new Map(source.map((c) => [c.id, c.text]));
    return (id) => byId.get(id) ?? "";
  }
  if (source && typeof source === "object") return (id) => source[id] ?? "";
  return () => "";
}

function readBenefitsSnapshot(source) {
  const col = toColumnReader(source);
  const text = (id) => {
    const v = col(id);
    return v == null ? "" : String(v);
  };

  const version = text(COLUMNS.BNF_VERSION).trim();
  const flags = parseFlagCodes(text(COLUMNS.BNF_FLAGS));

  return {
    recurring: parseEstimateText(text(COLUMNS.OOP_ESTIMATE)),
    firstOrder: parseEstimateText(text(COLUMNS.BNF_FIRST_WMON)),
    confidence: normalizeConfidence(text(COLUMNS.BNF_CONFIDENCE)),
    flags,
    flagText: flags.map(flagText),
    note: text(COLUMNS.BNF_OOP_NOTE).trim(),
    version,
    // BLANK version = the backend has not resolved this item yet; every other column is
    // then either blank or stale, and a reader must say "—", never $0.
    present: version !== "",
  };
}

// "Need benefits" rows carry the missing inputs in the note as "missing: a, b".
function missingFromNote(note) {
  const m = /missing:\s*([^\n]+)/i.exec(note || "");
  if (!m) return [];
  return m[1].split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
}

// ─── Backend call ───
// POST {STEDI_BACKEND_URL}/oop/estimate  (header X-Admin-Key)
//   {"board": "subscription", "item_id": "123", "infusion_sets": 6, "sensors_per_fill": 3}
// The backend reads the row from Monday itself, so the only thing this call adds is the
// quantity the patient is choosing on the form.
//
// Returns one of:
//   { ok: true,  estimate: {low, high, text}, patientPaysNothing, zeroReason, confidence,
//     flags, flagText, needsBenefits, snapshotPresent, primaryLabel, serving, raw }
//   { ok: false, reason: "need benefits", needsBenefits: [...], confidence, flags, flagText,
//     zeroReason, snapshotPresent, raw }     — the backend answered, but a money field is null
//   { ok: false, reason: "...", unavailable: true }  — not configured / timeout / network /
//     non-2xx / malformed; the caller should fall back to the Monday column
//
// `money` picks which estimate the caller wants; the reorder form shows consumables only,
// so it reads `recurring` (deductible treated as met) — the same thing the Monday column holds.

function normalizeMoney(field) {
  if (!field || typeof field !== "object") return null;
  // null / "" must stay unknown — Number(null) is 0, and 0 would read as "you owe nothing".
  if (field.low == null || field.high == null || field.low === "" || field.high === "") return null;
  const low = Number(field.low);
  const high = Number(field.high);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const text = field.text != null && String(field.text).trim() !== ""
    ? String(field.text).trim()
    : (low === high ? low.toFixed(2) : `${low.toFixed(2)}-${high.toFixed(2)}`);
  return { low: Math.min(low, high), high: Math.max(low, high), text };
}

function stringList(v) {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

async function fetchBackendEstimate({ itemId, infusionSets, sensorsPerFill, money = "recurring" } = {}, opts = {}) {
  const cfg = { ...stediBackendConfig(), ...opts };
  const doFetch = opts.fetch || globalThis.fetch;

  if (!cfg.url || !cfg.adminKey) {
    return { ok: false, reason: "not configured", unavailable: true };
  }
  if (!/^\d+$/.test(String(itemId || ""))) {
    return { ok: false, reason: "invalid item id", unavailable: true };
  }

  const body = { board: "subscription", item_id: String(itemId) };
  if (infusionSets != null && Number.isFinite(Number(infusionSets))) body.infusion_sets = Number(infusionSets);
  if (sensorsPerFill != null && Number.isFinite(Number(sensorsPerFill))) body.sensors_per_fill = Number(sensorsPerFill);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let res;
  try {
    res = await doFetch(`${cfg.url}/oop/estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Key": cfg.adminKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err && (err.name === "AbortError" || err.name === "TimeoutError");
    return { ok: false, reason: timedOut ? `timeout after ${cfg.timeoutMs}ms` : `unreachable: ${err && err.message}`, unavailable: true };
  } finally {
    clearTimeout(timer);
  }

  if (!res || !res.ok) {
    return { ok: false, reason: `http ${res ? res.status : "?"}`, unavailable: true };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: "malformed response", unavailable: true };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, reason: "malformed response", unavailable: true };
  }

  const fieldName = { recurring: "recurring", firstOrder: "first_order", firstOrderNoMonitor: "first_order_no_monitor" }[money] || "recurring";
  const flags = stringList(json.flags);
  const common = {
    confidence: normalizeConfidence(json.confidence),
    flags,
    flagText: stringList(json.flag_text).length === flags.length ? stringList(json.flag_text) : flags.map(flagText),
    needsBenefits: stringList(json.needs_benefits),
    zeroReason: json.zero_reason ? String(json.zero_reason) : "",
    snapshotPresent: json.snapshot_present === true,
    primaryLabel: json.primary_label ? String(json.primary_label) : "",
    serving: json.serving ? String(json.serving) : "",
    raw: json,
  };

  if (json.patient_pays_nothing === true) {
    return { ok: true, estimate: { low: 0, high: 0, text: "$0" }, patientPaysNothing: true, ...common };
  }

  const estimate = normalizeMoney(json[fieldName]);
  if (!estimate) {
    return { ok: false, reason: "need benefits", patientPaysNothing: false, ...common };
  }
  return { ok: true, estimate, patientPaysNothing: false, ...common };
}

module.exports = {
  parseEstimateText,
  readBenefitsSnapshot,
  fetchBackendEstimate,
  parseFlagCodes,
  flagText,
  flagConfidence,
  normalizeConfidence,
  missingFromNote,
  FLAGS_SNAPSHOT,
};
