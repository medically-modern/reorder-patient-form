// Verify the patient form's infusion-set dropdowns against the live Subscription board.
//
// WHY: the three dropdowns in docs/app.js compose a label ("brand size tubing") and the
// backend writes it by resolving that label against the board's own labels
// (monday.js resolveStatusIndex). The label is therefore a CONTRACT, and nothing in the
// normal flow reports a breach of it — resolveStatusIndex just returns null and the save
// is recorded as a failure the patient never sees explained.
//
// That is not hypothetical: this map spelled four products "6mm"/"9mm" while the boards
// spell every cannula size "N mm". Contact, Inset, Luer and Mio Advance Clear could not
// be saved at all, and a patient already on one of them had their set silently rendered
// as a different product, because parseInfusionLabel could not match their value either.
// Whitespace normalisation does not rescue this: both sides collapse runs of spaces, but
// neither ever INSERTS one, so "6mm" and "6 mm" are simply different strings.
//
// Run: MONDAY_TOKEN=... npm run check:labels   (exits non-zero on drift, so it can gate CI)
//
// Slot 1 and slot 2 are checked independently — they carry different product lists and
// drift apart separately.

const fs = require("fs");
const path = require("path");
const { SUBSCRIPTION_BOARD_ID, COLUMNS } = require("./config");
const { SKU_BOARD_ID, GROUPS, alias } = require("./skuStatus");

const API_URL = "https://api.monday.com/v2";

// Products the form can offer that have no row on the Cardinal SKU Tracker, each with
// the reason. A product not listed here and missing from the tracker is a coverage hole:
// the patient gets no backorder warning for it, silently.
const NO_SKU_ROW = {
  Instinct:
    "live Sensors Type label with no tracker row — unconfirmed whether this is a real " +
    "product or a stale label. Patients on it get no stock status until that is settled",
};

// Products the form deliberately does NOT offer, each with the reason. Anything else that
// is on the board but missing from the form is reported as drift.
const INTENTIONALLY_NOT_OFFERED = {
  'Luer 6 mm 32"':
    "no label on the Order board and no Cardinal SKU — it would copy across as blank " +
    "and the order would ship with no infusion set",
};

// Same folding the board resolver uses: narrow no-break space (U+202F), non-breaking
// space (U+00A0) and doubled runs collapse; nothing ever inserts a space.
function norm(s) {
  return String(s || "")
    .replace(/[  ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Read the two maps out of the browser file rather than duplicating them here — a second
// copy would be the very drift this script exists to catch.
function loadFormMaps() {
  const src = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  const cut = (start, end) => {
    const a = src.indexOf(start);
    const b = src.indexOf(end, a);
    if (a < 0 || b < 0) throw new Error(`could not locate ${start} in docs/app.js`);
    return src.slice(a, b);
  };
  const code = [
    cut("const INFUSION_MAP = {", "const PUMP_INFUSION_FILTER"),
    cut("function joinLabel(", "function getAllowedBrands"),
  ].join("\n");
  const out = {};
  new Function("out", `${code}\nObject.assign(out, { INFUSION_MAP, INFUSION_MAP_SET2, joinLabel });`)(out);

  const expand = (map) => {
    const labels = [];
    for (const [brand, sizes] of Object.entries(map)) {
      for (const [size, tubings] of Object.entries(sizes)) {
        for (const tubing of tubings) labels.push(out.joinLabel(brand, size, tubing));
      }
    }
    return labels;
  };
  return { set1: expand(out.INFUSION_MAP), set2: expand(out.INFUSION_MAP_SET2) };
}

async function gql(token, query) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Monday HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Monday API: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchBoardLabels(token) {
  const data = await gql(token, `query {
    boards(ids: [${SUBSCRIPTION_BOARD_ID}]) {
      columns(ids: ["${COLUMNS.INFUSION_SET_1}", "${COLUMNS.INFUSION_SET_2}", "${COLUMNS.SENSORS_TYPE}", "${COLUMNS.SUPPLIES_TYPE}"]) { id settings_str }
    }
  }`);

  const byId = {};
  for (const col of data.boards[0].columns) {
    // Drop Monday's reserved blank label (the "unset" sentinel) and "Not Serving",
    // which is a state rather than a product the form should offer.
    byId[col.id] = Object.values(JSON.parse(col.settings_str).labels).filter(
      (l) => l !== "" && l !== "Not Serving"
    );
  }
  return {
    set1: byId[COLUMNS.INFUSION_SET_1],
    set2: byId[COLUMNS.INFUSION_SET_2],
    sensors: byId[COLUMNS.SENSORS_TYPE],
    supplies: byId[COLUMNS.SUPPLIES_TYPE],
  };
}

// Rows on the Cardinal SKU Tracker, as { group -> Set(normalised name) }.
async function fetchSkuRows(token) {
  const data = await gql(token, `query {
    boards(ids: [${SKU_BOARD_ID}]) {
      items_page(limit: 500) { items { name group { title } } }
    }
  }`);

  const byGroup = {};
  for (const item of data.boards[0].items_page.items) {
    const g = item.group?.title;
    if (!g) continue;
    byGroup[g] ||= { direct: new Set(), aliased: new Set() };

    // Expand exactly the way skuStatus.buildIndex does, and in the same DIRECTION —
    // the alias is inserted into the TRACKER's spelling ("9mm" -> "9 mm") so it can meet
    // the form's. Applying it to the form's label instead finds nothing, because that
    // side already has the space and alias() only ever inserts one.
    const n = norm(item.name);
    byGroup[g].direct.add(n);
    const spaced = alias(n);
    if (spaced) byGroup[g].aliased.add(spaced);
  }
  return byGroup;
}

// Every product the form can put in front of a patient should resolve to a tracker row,
// otherwise that patient silently gets no backorder warning.
//
// Two severities, because they need different responses. A product with NO row under any
// spelling is a hole — hard fail. A product that resolves only after inserting a space
// into "9mm" is already handled at runtime by skuStatus.alias, so it is a warning that
// names the fix rather than a build break.
function compareSku(label, group, offered, rows) {
  const have = rows[group];
  const problems = [];
  const warnings = [];

  if (!have) {
    problems.push(
      `tracker has no group named ${JSON.stringify(group)} — every ${label} status is missing. ` +
        "If the group was renamed, update GROUPS in skuStatus.js to match."
    );
    return { problems, warnings };
  }

  for (const product of offered) {
    const n = norm(product);
    if (have.direct.has(n)) continue;

    if (have.aliased.has(n)) {
      warnings.push(
        `tracker spells ${JSON.stringify(product)} without the space in its cannula size. ` +
          "skuStatus.alias covers it, but rename the tracker item to match and the alias " +
          "becomes dead code (check skuwatch.js keys on the SKU column first)"
      );
      continue;
    }

    const why = NO_SKU_ROW[product];
    if (why) console.log(`  note: ${label} ${JSON.stringify(product)} has no tracker row — ${why}`);
    else problems.push(`${JSON.stringify(product)} has no tracker row — patients on it get no stock status`);
  }
  return { problems, warnings };
}

function compare(slot, offered, board) {
  const boardByNorm = new Map(board.map((l) => [norm(l), l]));
  const offeredNorm = new Set(offered.map(norm));
  const problems = [];

  for (const label of offered) {
    if (boardByNorm.has(norm(label))) {
      // Folds together but is not byte-identical: Monday's own copy between boards
      // matches on exact text, so this still breaks downstream even though we can save it.
      const exact = boardByNorm.get(norm(label));
      if (exact !== label) {
        problems.push(`offers ${JSON.stringify(label)} but the board spells it ${JSON.stringify(exact)}`);
      }
      continue;
    }
    problems.push(`offers ${JSON.stringify(label)} — NOT a label on the board, so saving it fails`);
  }

  for (const label of board) {
    if (offeredNorm.has(norm(label))) continue;
    const why = INTENTIONALLY_NOT_OFFERED[label];
    if (why) console.log(`  note: ${slot} does not offer ${JSON.stringify(label)} — ${why}`);
    else problems.push(`does not offer ${JSON.stringify(label)}, which the board has`);
  }
  return problems;
}

async function main() {
  const token = process.env.MONDAY_TOKEN;
  if (!token) {
    console.error("MONDAY_TOKEN is not set");
    process.exit(2);
  }
  const form = loadFormMaps();
  const board = await fetchBoardLabels(token);

  let total = 0;
  for (const slot of ["set1", "set2"]) {
    const problems = compare(slot, form[slot], board[slot]);
    console.log(
      `${slot}: ${form[slot].length} offered vs ${board[slot].length} on the board — ` +
        `${problems.length} problem(s)`
    );
    for (const p of problems) console.log(`  ${slot} ${p}`);
    total += problems.length;
  }

  // ─── Cardinal SKU Tracker coverage ───
  // Drift here does not break a save the way a Subscription label mismatch does — it
  // costs the patient their backorder warning instead, which fails quietly in the other
  // direction: the reorder goes through for something that cannot ship.
  console.log("\nCardinal SKU Tracker coverage:");
  const rows = await fetchSkuRows(token);
  let warnCount = 0;
  const checks = [
    ["infusion set 1", GROUPS.INFUSION_SETS, form.set1],
    ["infusion set 2", GROUPS.INFUSION_SETS, form.set2],
    ["sensors", GROUPS.SENSORS, board.sensors],
    ["cartridges", GROUPS.CARTRIDGES, board.supplies],
  ];
  for (const [label, group, offered] of checks) {
    const { problems, warnings } = compareSku(label, group, offered, rows);
    const covered = offered.length - problems.length - warnings.length;
    console.log(`  ${label}: ${covered}/${offered.length} resolve to a tracker row`);
    for (const w of warnings) console.log(`  WARN ${label} ${w}`);
    for (const p of problems) console.log(`  ${label} ${p}`);
    total += problems.length;
    warnCount += warnings.length;
  }

  if (total > 0) {
    console.error(
      "\nFAIL: the form has drifted from the boards. Subscription mismatches are saves " +
        "the patient cannot complete; tracker gaps are backorder warnings they never see."
    );
    process.exit(1);
  }
  console.log(
    `\nOK: every option the form offers is a live board label` +
      (warnCount > 0 ? `, with ${warnCount} tracker spelling warning(s) above.` : ".")
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Label check failed to run: ${err.message}`);
    process.exit(2);
  });
}

module.exports = { norm, loadFormMaps, compare, compareSku, INTENTIONALLY_NOT_OFFERED, NO_SKU_ROW };
