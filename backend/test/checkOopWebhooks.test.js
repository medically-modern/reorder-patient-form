// checkOopWebhooks — identifies leftover webhooks of the retired OOP refresh. Pure parts only.
const test = require("node:test");
const assert = require("node:assert/strict");

const { COLUMNS, RETIRED_OOP_WEBHOOK_COLUMNS } = require("../src/config");
const { webhookColumnId, findRetiredOopWebhooks } = require("../src/checkOopWebhooks");

test("reads the column id out of Monday's Ruby-style config string", () => {
  assert.equal(webhookColumnId('{"columnId" => "text_mm3g32ja"}'), "text_mm3g32ja");
  assert.equal(webhookColumnId('{"columnId":"color_mm254qxj"}'), "color_mm254qxj");
  assert.equal(webhookColumnId(""), null);
  assert.equal(webhookColumnId(null), null);
});

test("only column-change webhooks on the former input columns are leftovers", () => {
  const webhooks = [
    { id: 1, event: "change_specific_column_value", config: '{"columnId" => "' + COLUMNS.PRIMARY_INS + '"}' },
    { id: 2, event: "change_specific_column_value", config: '{"columnId" => "' + COLUMNS.STEDI_COINSURANCE + '"}' },
    { id: 3, event: "change_specific_column_value", config: '{"columnId" => "' + COLUMNS.OOP_ESTIMATE + '"}' },   // not an input
    { id: 4, event: "change_specific_column_value", config: '{"columnId" => "' + COLUMNS.PHONE + '"}' },          // someone else's
    { id: 5, event: "create_item", config: "{}" },
  ];
  assert.deepEqual(findRetiredOopWebhooks(webhooks), [
    { id: "1", columnId: COLUMNS.PRIMARY_INS },
    { id: "2", columnId: COLUMNS.STEDI_COINSURANCE },
  ]);
  assert.deepEqual(findRetiredOopWebhooks([]), []);
  assert.deepEqual(findRetiredOopWebhooks(undefined), []);
});

test("the retired list is the ten former input columns and never OOP_ESTIMATE", () => {
  assert.equal(RETIRED_OOP_WEBHOOK_COLUMNS.length, 10);
  assert.ok(!RETIRED_OOP_WEBHOOK_COLUMNS.includes(COLUMNS.OOP_ESTIMATE));
});
