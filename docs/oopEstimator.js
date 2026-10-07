/**
 * oopEstimator.js — out-of-pocket estimate READER (browser copy).
 *
 * This file used to be a byte-identical mirror of backend/src/oopEstimator.js carrying
 * the whole estimator: a rate table, a zero-OOP payer set, a Medicaid label set and the
 * deductible / coinsurance arithmetic. None of that lives in a frontend any more. The
 * Stedi backend (stedi-monday-integration) owns every rate and rule and writes the
 * estimate to Monday; the form asks its own backend (GET /api/oop-estimate), which
 * either relays the Stedi backend's answer or reads the Monday column.
 *
 * What is left here is text handling only — the same parseEstimateText as the backend
 * copy, for the formats the Stedi backend writes — so the browser never has to guess a
 * number. Plain script, no modules: index.html loads it with a <script src> tag before
 * app.js. NO rate table, NO payer set, NO arithmetic may be added here.
 *
 * Formats:  "$228.75"  "$228.75-$533.75"  "$0" (a who-pays rule)  "$0.00" (priced at zero)
 *           "Need benefits"  "" (not written yet)
 */

var OOP_MONEY_SRC = "\\$?\\s*(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?";
var OOP_SINGLE_RE = new RegExp("^" + OOP_MONEY_SRC + "$");
var OOP_RANGE_RE = new RegExp("^" + OOP_MONEY_SRC + "\\s*(?:-|\u2013|\u2014|to)\\s*" + OOP_MONEY_SRC + "$", "i");

function oopToMoney(whole, cents) {
  var n = Number(String(whole).replace(/,/g, "") + "." + ((cents || "0") + "00").slice(0, 2));
  return isFinite(n) ? n : null;
}

/**
 * Parse the estimate text the Stedi backend writes.
 * @returns {{kind: "amount"|"range"|"zero"|"needBenefits"|"unwritten", low: number|null, high: number|null, text: string}}
 */
function parseEstimateText(raw) {
  var text = raw == null ? "" : String(raw).trim();
  if (!text) return { kind: "unwritten", low: null, high: null, text: "" };

  if (/^need benefits$/i.test(text)) return { kind: "needBenefits", low: null, high: null, text: text };
  if (/^\$\s*0$/.test(text)) return { kind: "zero", low: 0, high: 0, text: text };

  var range = OOP_RANGE_RE.exec(text);
  if (range) {
    var lo = oopToMoney(range[1], range[2]);
    var hi = oopToMoney(range[3], range[4]);
    if (lo !== null && hi !== null) {
      return { kind: "range", low: Math.min(lo, hi), high: Math.max(lo, hi), text: text };
    }
  }

  var single = OOP_SINGLE_RE.exec(text);
  if (single) {
    var n = oopToMoney(single[1], single[2]);
    if (n !== null) return { kind: "amount", low: n, high: n, text: text };
  }

  // Text the retired in-repo estimator used to write, still on rows not rewritten yet.
  if (/^incomplete benefits/i.test(text)) return { kind: "needBenefits", low: null, high: null, text: text };

  return { kind: "unwritten", low: null, high: null, text: text };
}

function oopMoneyText(n) {
  return "$" + Number(n).toFixed(2);
}

/**
 * The text the card shows for a parsed estimate: "$228.75", "$228.75–$533.75", "$0",
 * "Need benefits", or "" when there is nothing to show.
 */
function formatEstimateText(parsed) {
  if (!parsed) return "";
  switch (parsed.kind) {
    case "amount": return oopMoneyText(parsed.low);
    case "range": return oopMoneyText(parsed.low) + "\u2013" + oopMoneyText(parsed.high);
    case "zero": return "$0";
    case "needBenefits": return "Need benefits";
    default: return "";
  }
}
