// The OOP input webhooks are RETIRED — this script now only finds and removes them.
//
// HISTORY: from 2026-09-30 to 2026-10 this repo recomputed OOP_ESTIMATE itself, and a
// Monday webhook on each input column (RETIRED_OOP_WEBHOOK_COLUMNS in config.js) called
// POST /webhooks/monday/oop-inputs to trigger that. This script then FAILED when any of
// those columns had no webhook. The Stedi backend now resolves benefits and writes the
// column, so the webhooks have nothing to trigger: the route acknowledges and ignores
// them, and the right end state is that none of them exist on the board.
//
// Run:    MONDAY_TOKEN=... npm run check:oop-webhooks              (lists leftovers, exits 0)
// Delete: MONDAY_TOKEN=... npm run check:oop-webhooks -- --delete  (removes them)
//
// LIMIT: Monday's API does not return a webhook's URL, only its event and column. So a
// leftover is identified by column, not by where it points. When this repo created them
// (2026-09-30) no other webhook watched any of these columns; if some other integration
// has since added one on the same column, --delete would take that too — check the
// board's Integrations view first if in doubt.

const { SUBSCRIPTION_BOARD_ID, COLUMNS, RETIRED_OOP_WEBHOOK_COLUMNS } = require("./config");

const API_URL = "https://api.monday.com/v2";
const EVENT = "change_specific_column_value";

async function monday(token, query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2024-10" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  // Monday reports rejected calls as HTTP 200 with errors[] — read it.
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

// config comes back Ruby-hash style: {"columnId" => "text_mm3g32ja"}
function webhookColumnId(config) {
  const m = /"columnId"\s*(?:=>|:)\s*"([a-z0-9_]+)"/.exec(config || "");
  return m ? m[1] : null;
}

// Which of the board's webhooks are leftovers of the retired OOP refresh: a
// column-change webhook on one of the former input columns. Pure, for the test.
function findRetiredOopWebhooks(webhooks, retiredColumns = RETIRED_OOP_WEBHOOK_COLUMNS) {
  const retired = new Set(retiredColumns);
  const out = [];
  for (const w of webhooks || []) {
    if (w.event !== EVENT) continue;
    const col = webhookColumnId(w.config);
    if (col && retired.has(col)) out.push({ id: String(w.id), columnId: col });
  }
  return out;
}

async function main() {
  const token = process.env.MONDAY_TOKEN;
  if (!token) throw new Error("MONDAY_TOKEN is not set");
  const del = process.argv.includes("--delete");

  console.log("OOP input webhooks are RETIRED: the Stedi backend writes OOP Estimate; this backend no longer recomputes it.");

  const data = await monday(token, `{ webhooks(board_id: ${SUBSCRIPTION_BOARD_ID}) { id event config } }`);
  const webhooks = data.webhooks || [];
  const leftovers = findRetiredOopWebhooks(webhooks);

  const onEstimate = webhooks.filter((w) => w.event === EVENT && webhookColumnId(w.config) === COLUMNS.OOP_ESTIMATE);
  if (onEstimate.length > 0) {
    console.warn(`WARN: webhook(s) ${onEstimate.map((w) => w.id).join(", ")} watch OOP Estimate itself; not this repo's, left alone.`);
  }

  if (leftovers.length === 0) {
    console.log("\nOK: no retired OOP input webhooks remain on the board.");
    return;
  }

  console.log(`\n${leftovers.length} retired webhook(s) still on the board (they POST to a route that ignores them):`);
  for (const w of leftovers) console.log(`  webhook ${w.id} on ${w.columnId}`);

  if (!del) {
    console.log("\nOK: nothing is broken by their existence. Re-run with --delete to remove them.");
    return;
  }

  for (const w of leftovers) {
    await monday(token, `mutation ($id: ID!) { delete_webhook(id: $id) { id } }`, { id: w.id });
    console.log(`  deleted webhook ${w.id} (${w.columnId})`);
  }
  console.log(`\nOK: deleted ${leftovers.length} retired webhook(s).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`OOP webhook check failed to run: ${err.message}`);
    process.exit(2);
  });
}

module.exports = { webhookColumnId, findRetiredOopWebhooks };
