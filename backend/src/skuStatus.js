// Live Cardinal stock status for the products the reorder form can offer.
//
// WHY: the form lets a patient confirm a reorder for a set that Cardinal cannot ship.
// On the data as of 2026-08-06 that is 7 of the 24 infusion sets the form offers, plus
// Dexcom G6 — roughly a third of the infusion picker. The patient finds out weeks later
// when the order does not arrive.
//
// The Cardinal SKU Tracker board already carries the answer: a poller validates a
// read-only cart per SKU every morning at 9:05 ET and writes PROD Status back. This
// module reads that board and hands the form a lookup it can render against.
//
// THE JOIN: the tracker's item NAMES are already spelled to match the Subscription
// board's dropdown labels, so no mapping table is needed. Two things make the naive
// version wrong, and both are load-bearing:
//
//   1. Names are NOT unique board-wide. "Mobi", "iLet", "t:slim" and "Minimed 780G"
//      each exist twice — once as a pump, once as a cartridge — with different SKUs
//      and independently moving stock. Mobi is TN1017800G (pump) and TN1016647I
//      (cartridge). A name-only lookup returns whichever row the API happened to
//      serialise first, so the key MUST include the group.
//
//   2. The tracker spells one product "Mio Advance Clear 9mm 23"" while every other
//      board spells cannula sizes "N mm" with a space. See ALIAS below.

const SKU_BOARD_ID = "18420366344";

const SKU_COLUMNS = {
  PROD_STATUS: "color_mm4wr14r",
};

// Group titles on the tracker. These are the second half of every lookup key, so they
// are a contract with the board exactly the way the infusion labels are — a renamed
// group silently drops every status in it. checkLabels.js asserts these exist.
const GROUPS = {
  SENSORS: "CGM Sensors",
  PUMPS: "Insulin Pumps",
  CARTRIDGES: "Cartridges",
  INFUSION_SETS: "Infusion Sets",
  RUN_LOG: "Run Log",
};

// Cardinal's four PROD Status values, folded to what a patient is told. The board's own
// precedence is Inactive > Restricted > Backordered > Available.
//
// Backordered, Restricted and Inactive all collapse to one patient-facing state: we
// cannot ship it, so steer them to something else for this order. Inactive means
// discontinued rather than temporarily out, but the form deliberately does not say so —
// the action we want is identical, and "on backorder" is the softer framing.
const UNAVAILABLE = new Set(["backordered", "restricted", "inactive"]);

// The tracker groups the form has somewhere to show a warning for. Must stay in step
// with STOCK_GROUPS in docs/app.js.
const PATIENT_GROUPS = new Set([GROUPS.SENSORS, GROUPS.CARTRIDGES, GROUPS.INFUSION_SETS]);

// If the poller has not run in this long, show nothing at all rather than present
// stale stock as fact. The cron's record is clean (31 consecutive daily runs as of
// 2026-08-06), so this should never fire — it exists so that a silently wedged poller
// degrades to the old no-status behaviour instead of misinforming patients for days.
const MAX_STALE_MS = 48 * 60 * 60 * 1000;

// The board changes once a day, so this could be far longer. It is deliberately short
// so that a hand-fixed status reaches patients within the quarter hour.
const CACHE_TTL_MS = 15 * 60 * 1000;

// Same folding the board resolvers use (monday.js resolveStatusIndex, checkLabels.js
// norm): narrow no-break space, non-breaking space and doubled runs collapse. Nothing
// here ever INSERTS a space — that asymmetry is why ALIAS below has to exist.
function norm(s) {
  return String(s || "")
    .replace(/[  ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// The tracker has "Mio Advance Clear 9mm 23""; the Subscription board, the Order board
// and the form all have "9 mm". norm() collapses runs of spaces but never inserts one,
// so those two strings simply never meet and that product resolves to nothing.
//
// Indexing each row under a space-inserted alias as well fixes it here, in the one
// module that cares, without touching the shared norm() contract that the save path
// depends on. The permanent fix is renaming the tracker item to "9 mm" — check that
// skuwatch.js keys on the SKU column and not the item name before doing it, then this
// alias becomes dead weight rather than a bug. check:labels reports the drift either way.
function alias(normalised) {
  const spaced = normalised.replace(/(\d)mm\b/g, "$1 mm");
  return spaced === normalised ? null : spaced;
}

function key(group, name) {
  return `${group}::${norm(name)}`;
}

let _cache = null;
let _cacheAt = 0;

// Injected so tests and check:labels can drive this without the whole monday.js graph.
async function fetchSkuBoard(mondayQuery) {
  const data = await mondayQuery(`{
    boards(ids: ${SKU_BOARD_ID}) {
      items_page(limit: 500) {
        cursor
        items {
          id
          name
          updated_at
          group { title }
          column_values(ids: ["${SKU_COLUMNS.PROD_STATUS}"]) { text }
        }
      }
    }
  }`);

  const page = data?.boards?.[0]?.items_page;
  if (!page) throw new Error("SKU board returned no items_page");
  if (page.cursor) {
    // 46 items today against a 500 limit. If this ever fires the tail is being dropped
    // silently, which reads to a patient as "this product has no status".
    console.warn("[sku] board exceeded one page — status for later items is missing");
  }
  return page.items || [];
}

// Build { asOf, byKey } from raw board items. Exported for testing without a network.
function buildIndex(items) {
  const byKey = new Map();
  let lastRunAt = 0;

  for (const item of items) {
    const group = item.group?.title;
    if (!group) continue;

    if (group === GROUPS.RUN_LOG) {
      // The poller appends to this item's Run History on every run, changed or not, so
      // its updated_at is the freshness signal. Parsing it out of the item name would
      // break the first time the poller reworded its own log line.
      const t = Date.parse(item.updated_at || "");
      if (!isNaN(t) && t > lastRunAt) lastRunAt = t;
      continue;
    }

    const status = item.column_values?.[0]?.text;
    if (!status) continue;

    const normalised = norm(item.name);
    byKey.set(`${group}::${normalised}`, status);

    const spaced = alias(normalised);
    // Never let an alias shadow a row that genuinely owns that spelling.
    if (spaced && !byKey.has(`${group}::${spaced}`)) {
      byKey.set(`${group}::${spaced}`, status);
    }
  }

  return { lastRunAt, byKey };
}

async function getProductStatus(mondayQuery) {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;

  const items = await fetchSkuBoard(mondayQuery);
  const { lastRunAt, byKey } = buildIndex(items);

  const age = lastRunAt ? Date.now() - lastRunAt : Infinity;
  const fresh = age < MAX_STALE_MS;
  if (!fresh) {
    console.warn(
      `[sku] poller last ran ${lastRunAt ? `${Math.round(age / 3600000)}h ago` : "never"} — ` +
        "suppressing patient-facing stock status"
    );
  }

  _cache = { fresh, lastRunAt, byKey };
  _cacheAt = Date.now();
  return _cache;
}

// Reduce the index to the flat { "Group::label": "backordered" } the form renders from.
// Only the unavailable products are sent: Available is the overwhelming majority and
// carries no badge, so shipping it would be payload for nothing. An absent key means
// "say nothing", which is also correct for a product the tracker has never heard of
// (Instinct, Luer 6 mm 32") — a guess presented to a patient as fact is worse than
// staying quiet.
function toPatientMap(index) {
  const out = {};
  if (!index.fresh) return out;
  for (const [k, status] of index.byKey) {
    // Only the groups the form actually renders. The tracker also carries Insulin Pumps
    // and CGM Receivers, neither of which the patient picks here — shipping their status
    // would imply a warning the form has nowhere to show. Add a group here when the form
    // grows a control for it.
    const group = k.slice(0, k.indexOf("::"));
    if (!PATIENT_GROUPS.has(group)) continue;
    if (UNAVAILABLE.has(norm(status))) out[k] = "backordered";
  }
  return out;
}

module.exports = {
  SKU_BOARD_ID,
  SKU_COLUMNS,
  GROUPS,
  UNAVAILABLE,
  PATIENT_GROUPS,
  CACHE_TTL_MS,
  MAX_STALE_MS,
  norm,
  alias,
  key,
  fetchSkuBoard,
  buildIndex,
  getProductStatus,
  toPatientMap,
};
