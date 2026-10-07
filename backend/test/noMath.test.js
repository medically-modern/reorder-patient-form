// The reader contract: a frontend holds NO rate table, NO coinsurance override set, NO
// zero-OOP payer set, NO Medicaid label set and NO deductible/coinsurance arithmetic.
// This scans backend/src and docs/ so none of it can quietly come back.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOTS = [
  path.join(__dirname, "..", "src"),
  path.join(__dirname, "..", "..", "docs"),
];

const FORBIDDEN_IDENTIFIERS = [
  "PAYER_RATE_SCHEDULE",
  "ZERO_OOP_PAYERS",
  "PRIMARY_MEDICAID_LABELS",
  "COINSURANCE_OVERRIDES",
  "MEDICARE_STYLE_INFUSION_PAYERS",
  "SUPPLIES_ROUTE_TO_MEDICAID",
  "HUMANA_CGM_PRODUCTS",
  "estimateOop(",
  "pump_rate",
  "sensor_rate",
  "infusion_rate",
  "cartridge_rate",
  "monitor_rate",
];

// A `new Set([...])` whose members look like payer labels is a payer set, whatever it is called.
const PAYER_LABEL_RE = /Medicare|Medicaid|Aetna|Humana|Fidelis|NYSHIP|Anthem|United|Cigna|Wellcare|BCBS|Horizon|Midlands|MagnaCare|UMR|Oregon Care/i;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs|json|html|css|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r));

test("the scan covers both halves of the repo", () => {
  const rel = files.map((f) => path.relative(path.join(__dirname, "..", ".."), f));
  assert.ok(rel.some((f) => f.endsWith(path.join("backend", "src", "oopEstimator.js"))), "backend reader is scanned");
  assert.ok(rel.some((f) => f.endsWith(path.join("docs", "oopEstimator.js"))), "browser reader is scanned");
  assert.ok(rel.some((f) => f.endsWith(path.join("docs", "app.js"))), "app.js is scanned");
});

for (const file of files) {
  const rel = path.relative(path.join(__dirname, "..", ".."), file);
  const text = fs.readFileSync(file, "utf8");

  test(`${rel} carries no estimator identifiers`, () => {
    for (const needle of FORBIDDEN_IDENTIFIERS) {
      assert.ok(!text.includes(needle), `${rel} contains ${needle}`);
    }
  });

  test(`${rel} carries no payer-label Set`, () => {
    const re = /new Set\(\s*\[([\s\S]*?)\]\s*\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      assert.ok(!PAYER_LABEL_RE.test(m[1]), `${rel} has a new Set([...]) of payer labels: ${m[1].trim().slice(0, 80)}`);
    }
  });
}

test("the browser reader is a plain script (no module syntax) and app.js never computes a cost", () => {
  const browser = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "oopEstimator.js"), "utf8");
  assert.ok(!/\bmodule\.exports\b|\bexport\s|\brequire\(/.test(browser), "docs/oopEstimator.js must stay a <script src> file");
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  assert.ok(!/deductibleRemaining|stediCoinsurance|oopMaxRemaining|coinsurancePct|patientOwes/.test(app), "app.js reads the estimate; it does not compute it");
  assert.ok(app.includes("/api/oop-estimate"), "app.js asks the backend route");
});

test("monday.js never writes the OOP Estimate column", () => {
  const monday = fs.readFileSync(path.join(__dirname, "..", "src", "monday.js"), "utf8");
  assert.ok(!/writeText\([^)]*COLUMNS\.OOP_ESTIMATE/.test(monday), "no writeText to OOP_ESTIMATE");
  assert.ok(!/columnId:\s*COLUMNS\.OOP_ESTIMATE/.test(monday), "no mutation targeting OOP_ESTIMATE");
  assert.ok(!/text_mm404p7d.*JSON\.stringify/.test(monday), "no raw write of text_mm404p7d");
});
