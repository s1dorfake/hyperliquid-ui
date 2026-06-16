"use strict";
// Plain Node test runner (no deps). Run: node test/match.test.js
var M = require("../src/match.js");
var assert = require("assert");

var passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  - " + name);
  } catch (e) {
    console.error("  FAIL- " + name);
    console.error("        " + e.message);
    process.exitCode = 1;
  }
}

// --- isNumberText ---
test("isNumberText accepts plain and comma-formatted numbers", function () {
  assert.strictEqual(M.isNumberText("2950"), true);
  assert.strictEqual(M.isNumberText("2,950.5"), true);
  assert.strictEqual(M.isNumberText(" 0.0312 "), true);
  assert.strictEqual(M.isNumberText("-12.5"), true);
});
test("isNumberText rejects non-numbers", function () {
  assert.strictEqual(M.isNumberText("BTC"), false);
  assert.strictEqual(M.isNumberText("$12"), false);
  assert.strictEqual(M.isNumberText("12.3.4"), false);
  assert.strictEqual(M.isNumberText(""), false);
  assert.strictEqual(M.isNumberText("12px"), false);
});

// --- priceKey canonicalization ---
test("priceKey collides equivalent representations", function () {
  assert.strictEqual(M.priceKey("2,950.0"), M.priceKey("2950"));
  assert.strictEqual(M.priceKey("2950.00"), M.priceKey("2950"));
  assert.strictEqual(M.priceKey("0.030"), M.priceKey("0.03"));
  assert.strictEqual(M.priceKey("not a price"), null);
});

// --- categorize ---
test("categorize identifies limit / trigger / reduce", function () {
  assert.strictEqual(M.categorize({ orderType: "Limit" }), "limit");
  assert.strictEqual(M.categorize({ isTrigger: true }), "trigger");
  assert.strictEqual(M.categorize({ triggerPx: "100.0" }), "trigger");
  assert.strictEqual(
    M.categorize({ orderType: "Stop Market" }),
    "trigger"
  );
  assert.strictEqual(
    M.categorize({ orderType: "Limit", reduceOnly: true }),
    "reduce"
  );
});
test("categorize: triggerPx of 0 is not a trigger", function () {
  assert.strictEqual(M.categorize({ triggerPx: "0.0", orderType: "Limit" }), "limit");
});

// --- buildIndex ---
test("buildIndex filters by coin and aggregates size at a price", function () {
  var orders = [
    { coin: "BTC", limitPx: "65000.0", sz: "0.5", side: "B", orderType: "Limit" },
    { coin: "BTC", limitPx: "65000", sz: "0.25", side: "B", orderType: "Limit" },
    { coin: "ETH", limitPx: "2950.0", sz: "2", side: "A", orderType: "Limit" },
  ];
  var idx = M.buildIndex(orders, "BTC");
  assert.strictEqual(idx.size, 1);
  var entry = idx.get(M.priceKey("65000"));
  assert.ok(entry, "entry exists for 65000");
  assert.strictEqual(entry.sz, 0.75);
  assert.ok(entry.cats.has("limit"));
});
test("buildIndex without coin keeps all", function () {
  var orders = [
    { coin: "BTC", limitPx: "65000", sz: "1", side: "B" },
    { coin: "ETH", limitPx: "2950", sz: "1", side: "A" },
  ];
  assert.strictEqual(M.buildIndex(orders).size, 2);
});
test("buildIndex mixes categories at the same price", function () {
  var orders = [
    { coin: "BTC", limitPx: "100", sz: "1", side: "A", orderType: "Limit" },
    { coin: "BTC", limitPx: "100", sz: "1", side: "A", isTrigger: true },
  ];
  var idx = M.buildIndex(orders, "BTC");
  var entry = idx.get(M.priceKey("100"));
  assert.strictEqual(M.primaryCat(entry), "trigger");
  assert.strictEqual(entry.sz, 2);
});
test("buildIndex tolerates junk input", function () {
  assert.strictEqual(M.buildIndex(null).size, 0);
  assert.strictEqual(M.buildIndex([null, {}, { coin: "X" }]).size, 0);
});

// --- formatSz ---
test("formatSz formats with thousands separators and trims float noise", function () {
  assert.strictEqual(M.formatSz(1234.5), "1,234.5");
  assert.strictEqual(M.formatSz(0.03), "0.03");
  assert.strictEqual(M.formatSz(1000000), "1,000,000");
  assert.strictEqual(M.formatSz(0.1 + 0.2), "0.3");
});

// --- end-to-end matching path mirrors content.js usage ---
test("priceKey of rendered row text matches an indexed order", function () {
  var idx = M.buildIndex(
    [{ coin: "ETH", limitPx: "2950.5", sz: "3.0", side: "B", orderType: "Limit" }],
    "ETH"
  );
  // Simulate orderbook cell text as Hyperliquid might render it.
  assert.ok(idx.get(M.priceKey("2,950.5")), "comma-formatted row matches");
  assert.ok(idx.get(M.priceKey("2950.50")), "trailing-zero row matches");
  assert.strictEqual(idx.get(M.priceKey("2950.6")), undefined, "non-match");
});

console.log("\n" + passed + " checks passed");
