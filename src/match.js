// Pure, side-effect-free helpers for parsing prices and indexing orders.
// Loaded as a plain script in the content-script world (attaches to window),
// and also require()-able from Node for unit tests.
(function (root) {
  "use strict";

  var NUMBER_RE = /^-?[\d,]+(\.\d+)?$/;

  function isNumberText(s) {
    if (typeof s !== "string") return false;
    s = s.trim();
    if (s === "") return false;
    return NUMBER_RE.test(s);
  }

  function toNum(s) {
    if (typeof s === "number") return isFinite(s) ? s : null;
    if (typeof s !== "string") return null;
    var stripped = s.replace(/,/g, "").trim();
    if (stripped === "" || stripped === "-") return null;
    if (!NUMBER_RE.test(stripped)) return null;
    var n = Number(stripped);
    return isFinite(n) ? n : null;
  }

  // Canonical key for a price so "2,950.0", "2950", "2950.00" all collide.
  function priceKey(s) {
    var n = toNum(s);
    if (n === null) return null;
    return String(n);
  }

  function sideOf(o) {
    return o && o.side === "B" ? "buy" : "sell";
  }

  // Categorize an order for color-coding. Precedence: trigger > reduce > limit.
  function categorize(o) {
    if (!o) return "limit";
    var triggerPx = toNum(o.triggerPx);
    var isTrigger =
      o.isTrigger === true ||
      (triggerPx !== null && triggerPx > 0) ||
      /stop|take|trigger|tp|sl/i.test(o.orderType || "");
    if (isTrigger) return "trigger";
    if (o.reduceOnly === true) return "reduce";
    return "limit";
  }

  var CAT_PRECEDENCE = { trigger: 3, reduce: 2, limit: 1 };

  function primaryCat(entry) {
    var best = "limit";
    entry.cats.forEach(function (c) {
      if ((CAT_PRECEDENCE[c] || 0) > (CAT_PRECEDENCE[best] || 0)) best = c;
    });
    return best;
  }

  // Build a Map<priceKey, {sz, cats:Set, sides:Set, price}> from raw orders,
  // optionally filtered to a single coin.
  function buildIndex(orders, coin) {
    var map = new Map();
    if (!Array.isArray(orders)) return map;
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (!o) continue;
      if (coin && o.coin !== coin) continue;
      var k = priceKey(o.limitPx);
      if (k === null) continue;
      var sz = toNum(o.sz) || 0;
      var cat = categorize(o);
      var side = sideOf(o);
      var entry = map.get(k);
      if (entry) {
        entry.sz += sz;
        entry.cats.add(cat);
        entry.sides.add(side);
      } else {
        map.set(k, {
          price: k,
          sz: sz,
          cats: new Set([cat]),
          sides: new Set([side]),
        });
      }
    }
    return map;
  }

  // Compact size for the badge, e.g. 1234.5 -> "1,234.5", 0.030000 -> "0.03".
  function formatSz(n) {
    if (typeof n !== "number" || !isFinite(n)) return "";
    var rounded = Math.round(n * 1e6) / 1e6;
    var parts = String(rounded).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }

  // Round to k significant figures, returned as a number (no exponent for the
  // magnitudes we deal with). e.g. sigFigs(-1.86, 2) -> -1.9, sigFigs(186,2) -> 190.
  function sigFigs(n, k) {
    if (typeof n !== "number" || !isFinite(n) || n === 0) return 0;
    return Number(n.toPrecision(k));
  }

  var api = {
    isNumberText: isNumberText,
    toNum: toNum,
    priceKey: priceKey,
    sideOf: sideOf,
    categorize: categorize,
    primaryCat: primaryCat,
    buildIndex: buildIndex,
    formatSz: formatSz,
    sigFigs: sigFigs,
  };

  root.HLMatch = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
