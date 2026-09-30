// Verify every OOP estimate input column on the Subscription board has a webhook.
//
// WHY: OOP_ESTIMATE follows eligibility checks, insurance changes and product changes
// only because Monday calls POST /webhooks/monday/oop-inputs when one of
// OOP_INPUT_COLUMNS (config.js) changes. Those webhooks live on the board, not in this
// repo. Delete one — or add an input to the estimate without one — and the column
// silently goes back to being a link-creation snapshot for that input, which is the
// stale-$0.00 bug this exists to prevent.
//
// Run:    MONDAY_TOKEN=... npm run check:oop-webhooks            (exits 1 on a gap)
// Create: MONDAY_TOKEN=... OOP_WEBHOOK_URL='https://<backend>/webhooks/monday/oop-inputs?key=<OOP_WEBHOOK_SECRET>' \
//           npm run check:oop-webhooks -- --create               (adds only the missing ones)
//
// LIMIT: Monday's API does not return a webhook's URL, only its event and column. So
// this proves each column HAS a column-specific webhook, not that it points here. When
// these were created (2026-09-30) no other webhook watched any of these columns.

const { SUBSCRIPTION_BOARD_ID, COLUMNS, OOP_INPUT_COLUMNS } = require("./config");

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

async function main() {
  const token = process.env.MONDAY_TOKEN;
  if (!token) throw new Error("MONDAY_TOKEN is not set");
  const create = process.argv.includes("--create");

  const data = await monday(token, `{ webhooks(board_id: ${SUBSCRIPTION_BOARD_ID}) { id event config } }`);
  const byColumn = {};
  for (const w of data.webhooks || []) {
    if (w.event !== EVENT) continue;
    const col = webhookColumnId(w.config);
    if (col) (byColumn[col] = byColumn[col] || []).push(w.id);
  }

  if (byColumn[COLUMNS.OOP_ESTIMATE]) {
    console.warn(
      `WARN: webhook(s) ${byColumn[COLUMNS.OOP_ESTIMATE].join(", ")} watch OOP_ESTIMATE itself. ` +
        "If one points at /webhooks/monday/oop-inputs it is ignored (not an input), but it should not exist."
    );
  }

  const missing = [];
  for (const col of OOP_INPUT_COLUMNS) {
    const ids = byColumn[col];
    console.log(`  ${col}: ${ids ? `webhook ${ids.join(", ")}` : "MISSING"}`);
    if (!ids) missing.push(col);
  }

  if (missing.length === 0) {
    console.log(`\nOK: all ${OOP_INPUT_COLUMNS.length} OOP input columns have a webhook.`);
    return;
  }

  if (!create) {
    console.error(
      `\nFAIL: ${missing.length} input column(s) have no webhook — OOP_ESTIMATE will not follow changes to them. ` +
        "Re-run with --create and OOP_WEBHOOK_URL to add them."
    );
    process.exit(1);
  }

  const url = process.env.OOP_WEBHOOK_URL;
  if (!url || !/\/webhooks\/monday\/oop-inputs\?key=.+/.test(url)) {
    throw new Error("--create needs OOP_WEBHOOK_URL ending in /webhooks/monday/oop-inputs?key=<OOP_WEBHOOK_SECRET>");
  }
  for (const col of missing) {
    // Monday POSTs a challenge to the URL before accepting — the backend must be
    // deployed with OOP_WEBHOOK_SECRET set, or this fails.
    const created = await monday(
      token,
      `mutation ($board: ID!, $url: String!, $config: JSON!) {
        create_webhook(board_id: $board, url: $url, event: ${EVENT}, config: $config) { id }
      }`,
      { board: SUBSCRIPTION_BOARD_ID, url, config: JSON.stringify({ columnId: col }) }
    );
    console.log(`  created webhook ${created.create_webhook.id} for ${col}`);
  }
  console.log(`\nOK: created ${missing.length} webhook(s).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`OOP webhook check failed to run: ${err.message}`);
    process.exit(2);
  });
}

module.exports = { webhookColumnId };
