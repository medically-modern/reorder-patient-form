// parseEstimateText — every estimate format the Stedi backend writes (reader contract),
// on both copies: backend/src/oopEstimator.js and the browser's docs/oopEstimator.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backend = require("../src/oopEstimator");

// The browser copy is a plain script with no module system: run it in a sandbox and
// pull the globals out, so the test fails if someone turns it into a module.
function loadBrowserCopy() {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "oopEstimator.js"), "utf8");
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  // Objects from the sandbox have the sandbox's Object prototype; JSON round-trip them
  // so deepEqual compares values, not realms.
  const plain = (v) => JSON.parse(JSON.stringify(v));
  return {
    parseEstimateText: (t) => plain(vm.runInContext(`parseEstimateText(${JSON.stringify(t)})`, ctx)),
    formatEstimateText: (t) => vm.runInContext(`formatEstimateText(parseEstimateText(${JSON.stringify(t)}))`, ctx),
  };
}
const browser = loadBrowserCopy();

// text → expected {kind, low, high}; text is always echoed back trimmed
const CONTRACT_CASES = [
  ["$228.75",          { kind: "amount",       low: 228.75, high: 228.75 }],
  ["$228.75-$533.75",  { kind: "range",        low: 228.75, high: 533.75 }],
  ["$0",               { kind: "zero",         low: 0,      high: 0 }],       // a who-pays rule
  ["$0.00",            { kind: "amount",       low: 0,      high: 0 }],       // priced at zero (0% rows)
  ["Need benefits",    { kind: "needBenefits", low: null,   high: null }],
  ["",                 { kind: "unwritten",    low: null,   high: null }],    // backend has not written yet
];

const TOLERATED_CASES = [
  ["$228.75–$533.75",     { kind: "range",        low: 228.75, high: 533.75 }], // en dash
  ["$1,234.50",                { kind: "amount",       low: 1234.5, high: 1234.5 }],
  ["228.75",                   { kind: "amount",       low: 228.75, high: 228.75 }], // /oop/estimate "text" has no $
  ["$0-$1000",                 { kind: "range",        low: 0,      high: 1000 }],
  ["  $5.5 ",                  { kind: "amount",       low: 5.5,    high: 5.5 }],
  ["need benefits",            { kind: "needBenefits", low: null,   high: null }],
  ["Incomplete benefits data", { kind: "needBenefits", low: null,   high: null }], // retired estimator's text
  ["Error: No rate schedule for \"X\"", { kind: "unwritten", low: null, high: null }],
  ["N/A",                      { kind: "unwritten",    low: null,   high: null }],
  [null,                       { kind: "unwritten",    low: null,   high: null }],
  [undefined,                  { kind: "unwritten",    low: null,   high: null }],
];

for (const [text, expected] of [...CONTRACT_CASES, ...TOLERATED_CASES]) {
  test(`parseEstimateText(${JSON.stringify(text)}) → ${expected.kind}`, () => {
    const got = backend.parseEstimateText(text);
    assert.equal(got.kind, expected.kind);
    assert.equal(got.low, expected.low);
    assert.equal(got.high, expected.high);
    assert.equal(got.text, text == null ? "" : String(text).trim());
  });

  test(`browser copy agrees for ${JSON.stringify(text)}`, () => {
    assert.deepEqual(browser.parseEstimateText(text), backend.parseEstimateText(text));
  });
}

test("blank is never $0 — kind unwritten carries no number", () => {
  for (const blank of ["", "   ", null, undefined]) {
    const got = backend.parseEstimateText(blank);
    assert.equal(got.kind, "unwritten");
    assert.equal(got.low, null);
    assert.equal(got.high, null);
  }
});

test("'$0' (who-pays rule) and '$0.00' (priced at zero) are told apart", () => {
  assert.equal(backend.parseEstimateText("$0").kind, "zero");
  assert.equal(backend.parseEstimateText("$0.00").kind, "amount");
});

test("a reversed range is normalised so low ≤ high", () => {
  const got = backend.parseEstimateText("$533.75-$228.75");
  assert.equal(got.kind, "range");
  assert.equal(got.low, 228.75);
  assert.equal(got.high, 533.75);
});

test("browser formatEstimateText renders the card text", () => {
  assert.equal(browser.formatEstimateText("$228.75"), "$228.75");
  assert.equal(browser.formatEstimateText("$228.75-$533.75"), "$228.75–$533.75");
  assert.equal(browser.formatEstimateText("$0"), "$0");
  assert.equal(browser.formatEstimateText("$0.00"), "$0.00");
  assert.equal(browser.formatEstimateText("Need benefits"), "Need benefits");
  assert.equal(browser.formatEstimateText(""), "");
});
