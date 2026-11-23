// Monday's addresses are settings (MONDAY_API_URL, MONDAY_FILE_URL) whose defaults are today's
// addresses, so the January cutover to Friday is a variable and nothing changes until then.
// Reads source only: no Redis, Monday or network (the repo's rule for its tests).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const read = (f) => readFileSync(join(__dirname, "..", "src", f), "utf8");
const API = 'const API_URL = process.env.MONDAY_API_URL || "https://api.monday.com/v2";';
const FILE = 'const FILE_URL = process.env.MONDAY_FILE_URL || "https://api.monday.com/v2/file";';

test("every Monday client reads MONDAY_API_URL, defaulting to Monday's own address", () => {
  for (const f of ["monday.js", "checkLabels.js", "checkOopWebhooks.js"]) assert.ok(read(f).includes(API), f);
});

test("monday.js calls the API and the file upload only through the two settings", () => {
  const src = read("monday.js");
  assert.ok(src.includes(FILE));
  const targets = [...src.matchAll(/await fetch\(([^,]+),/g)].map((m) => m[1]);
  assert.deepEqual(targets, ["API_URL", "FILE_URL"]);
});

test("the defaults are today's addresses and the settings win when set", () => {
  const value = (line, env) => new Function("process", `${line} return typeof API_URL !== "undefined" ? API_URL : FILE_URL;`)({ env });
  assert.equal(value(API, {}), "https://api.monday.com/v2");
  assert.equal(value(FILE, {}), "https://api.monday.com/v2/file");
  assert.equal(value(API, { MONDAY_API_URL: "https://friday.example/v2" }), "https://friday.example/v2");
  assert.equal(value(FILE, { MONDAY_FILE_URL: "https://friday.example/v2/file" }), "https://friday.example/v2/file");
});
