// Runs in the ISOLATED world on app.hyperliquid.xyz.
// Receives the wallet address + active coin from injected.js, fetches the
// user's open orders via the background worker, and tints orderbook rows whose
// price matches one of the user's orders. Color-coded by order type, with a
// size badge.
(function () {
  "use strict";

  var M = window.HLMatch;

  var state = {
    user: null,
    wsCoin: null,
    enabled: true,
    debug: false,
    barMode: "cumulative",
    orders: [],
    index: new Map(),
    lastCount: 0,
  };

  var pollTimer = null;

  function log() {
    if (!state.debug) return;
    var args = ["[HL-highlighter]"].concat([].slice.call(arguments));
    console.log.apply(console, args);
  }

  // --- coin detection -------------------------------------------------------
  function coinFromUrl() {
    var m = location.pathname.match(/\/trade\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function activeCoin() {
    return state.wsCoin || coinFromUrl();
  }

  // --- messaging with the injected (MAIN world) script ----------------------
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__hlSource !== "hl-injected") return;
    if (d.type === "user" && d.user && d.user !== state.user) {
      state.user = d.user;
      log("wallet detected", d.user);
      refreshOrders();
    } else if (d.type === "coin" && d.coin && d.coin !== state.wsCoin) {
      state.wsCoin = d.coin;
      log("coin detected", d.coin);
      rebuildIndex();
      scheduleApply();
    } else if (d.type === "sub") {
      log("subscription seen:", d.subType, "coin:", d.coin);
    }
  });

  function sayHello() {
    window.postMessage({ __hlSource: "hl-content", type: "hello" }, "*");
  }

  // True until the extension is reloaded/updated, which orphans this content
  // script in already-open tabs (any chrome.* call then throws "Extension
  // context invalidated"). We detect that and shut down quietly.
  function isContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function shutdown() {
    if (pollTimer) clearInterval(pollTimer);
    if (applyTimer) clearTimeout(applyTimer);
    if (observer) observer.disconnect();
    pollTimer = null;
    log("context invalidated — shutting down (reload the page)");
  }

  // --- order fetching -------------------------------------------------------
  function refreshOrders() {
    if (!state.user) return;
    if (!isContextValid()) return shutdown();
    try {
      chrome.runtime.sendMessage(
        { type: "hl-fetch-orders", user: state.user },
        onOrders
      );
    } catch (_) {
      shutdown();
    }
  }

  function onOrders(resp) {
        if (!isContextValid()) return shutdown();
        if (chrome.runtime.lastError) {
          log("fetch error", chrome.runtime.lastError.message);
          return;
        }
        if (!resp || !resp.ok) {
          log("fetch failed", resp && resp.error);
          return;
        }
        state.orders = resp.orders;
        var coins = {};
        state.orders.forEach(function (o) {
          if (o && o.coin) coins[o.coin] = (coins[o.coin] || 0) + 1;
        });
        log("orders fetched:", state.orders.length, "by coin:", coins);
        rebuildIndex();
        scheduleApply();
  }

  function rebuildIndex() {
    state.index = M.buildIndex(state.orders, activeCoin());
    log("index size", state.index.size, "coin", activeCoin());
  }

  // --- highlighting ---------------------------------------------------------
  var HL_CLASSES = ["hl-myorder", "hl-limit", "hl-trigger", "hl-reduce"];

  function clearHighlights(root) {
    (root || document).querySelectorAll(".hl-myorder").forEach(function (el) {
      el.classList.remove.apply(el.classList, HL_CLASSES);
    });
    (root || document)
      .querySelectorAll(".hl-badge, .hl-seg, .hl-base, .hl-dist")
      .forEach(function (b) {
        b.remove();
      });
    (root || document)
      .querySelectorAll(".hl-hide-bar")
      .forEach(function (el) {
        el.classList.remove("hl-hide-bar");
      });
  }

  // Collect leaf elements whose text is a pure number, and mark all ancestors
  // (up to 8 levels) so we can recognize "rows" inside a list of >=5 siblings.
  function collectNumericLeaves(root) {
    var leaves = [];
    var hasNumeric = new Set();
    var spreadEl = null;
    var sizeUnit = null;
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length !== 0) continue;
      if (el.closest(".hl-badge")) continue;
      var text = el.textContent;
      if (!spreadEl && /^\s*Spread\b/.test(text || "")) spreadEl = el;
      if (!sizeUnit && text) {
        var um = text.trim().match(/^Size\s*\(([^)]+)\)/);
        if (um) sizeUnit = um[1];
      }
      if (!M.isNumberText(text)) continue;
      leaves.push(el);
      var a = el;
      for (var d = 0; d < 8 && a; d++) {
        hasNumeric.add(a);
        a = a.parentElement;
      }
    }
    return {
      leaves: leaves,
      hasNumeric: hasNumeric,
      spreadEl: spreadEl,
      // Is the book's Size/Total column quote-denominated (USDC) rather than
      // base units? Our order sizes are base units, so we must convert.
      sizeIsQuote: /^(usdc|usd)$/i.test(sizeUnit || ""),
    };
  }

  // Restrict highlighting to the orderbook only (not the Open Orders /
  // Positions tables, which are also lists of numeric rows). Primary anchor:
  // the "Spread" label that sits between bids and asks. Fallback: the densest
  // list of numeric rows on the page (the book has far more rows than the
  // order tables). Cached until the element detaches from the DOM.
  var cachedRoot = null;
  function findOrderbookRoot(scan) {
    if (cachedRoot && document.contains(cachedRoot)) return cachedRoot;
    cachedRoot = null;

    if (scan.spreadEl) {
      var node = scan.spreadEl;
      for (var d = 0; d < 10 && node.parentElement; d++) {
        node = node.parentElement;
        var n = 0;
        for (var i = 0; i < scan.leaves.length; i++) {
          if (node.contains(scan.leaves[i])) n++;
        }
        if (n >= 10) {
          cachedRoot = node;
          log("orderbook root via Spread anchor,", n, "rows");
          return cachedRoot;
        }
      }
    }

    var counts = new Map();
    for (var j = 0; j < scan.leaves.length; j++) {
      var row = findRow(scan.leaves[j], scan.hasNumeric);
      var list = row.parentElement || row;
      counts.set(list, (counts.get(list) || 0) + 1);
    }
    var best = null;
    var bestN = 0;
    counts.forEach(function (cnt, el) {
      if (cnt > bestN) {
        bestN = cnt;
        best = el;
      }
    });
    if (best && bestN >= 5) {
      cachedRoot = best;
      log("orderbook root via densest list,", bestN, "rows");
      return cachedRoot;
    }

    log("orderbook root not found; falling back to whole page");
    return document.body;
  }

  // Numeric leaves of a row in DOM order. Orderbook rows are Price | Size |
  // Total, so [price, size, total]. Used to place the badge (size) and read
  // the cumulative total for the depth-bar segment.
  function rowNumericLeaves(row) {
    var leaves = [];
    var all = row.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest(".hl-badge")) continue;
      if (el.children.length === 0 && M.isNumberText(el.textContent)) {
        leaves.push(el);
      }
    }
    return leaves;
  }

  // Append a small badge with literal text to a leaf cell.
  function addTextBadge(hostLeaf, cat, text, title) {
    if (!hostLeaf) return;
    var b = document.createElement("span");
    b.className = "hl-badge hl-badge-" + cat;
    b.textContent = text;
    if (title) b.title = title;
    hostLeaf.appendChild(b);
  }

  // Append a numeric (size) badge.
  function addBadge(hostLeaf, cat, value, title) {
    addTextBadge(hostLeaf, cat, M.formatSz(value), title);
  }

  // Mid price = (best bid + best ask) / 2, from the two price-color groups that
  // straddle the spread. Returns null if it can't be determined.
  function computeMid(rows) {
    var byColor = {};
    rows.forEach(function (r) {
      if (r.price == null || !isFinite(r.price)) return;
      (byColor[r.colorKey] = byColor[r.colorKey] || []).push(r.price);
    });
    var groups = Object.keys(byColor).map(function (ck) {
      var ps = byColor[ck];
      return { min: Math.min.apply(null, ps), max: Math.max.apply(null, ps) };
    });
    if (groups.length < 2) return null;
    groups.sort(function (a, b) {
      return a.min - b.min;
    });
    var lower = groups[0];
    var upper = groups[groups.length - 1];
    if (lower.max < upper.min) return (lower.max + upper.min) / 2;
    return null;
  }

  // Overlay a colored segment on the tip (right end) of the depth bar. The
  // native bar's width encodes the CUMULATIVE total at this level, so we size
  // our segment to the cumulative sum of OUR orders down to this level, as a
  // fraction of that cumulative total — keeping both on the same scale.
  function paintDepthSegment(row, bar, myCum, total, cat) {
    if (!total || total <= 0 || !myCum || myCum <= 0) return;
    var barW = parseFloat(bar.style.width);
    if (!isFinite(barW) || barW <= 0) return;
    var f = myCum / total;
    if (!isFinite(f) || f <= 0) return;
    if (f > 1) f = 1;
    var seg = document.createElement("div");
    seg.className = "hl-seg hl-seg-" + cat;
    seg.style.left = barW * (1 - f) + "%";
    seg.style.width = barW * f + "%";
    row.appendChild(seg);
  }

  // Render everything for the orderbook in one read-then-write pass. We FIRST
  // read every row's clean numeric leaves (price/size/total), THEN write badges
  // and bar overlays — so the size badge can't pollute leaf detection.
  // Returns the number of our-order levels found.
  function renderBook(root, mode, isQuote) {
    // --- read: every book row's clean numeric leaves ---
    var cand = root.querySelectorAll("div");
    var rows = [];
    for (var k = 0; k < cand.length; k++) {
      var bar = cand[k];
      var s = bar.style;
      if (
        !(s && s.position === "absolute" && s.width && s.width.indexOf("%") !== -1)
      )
        continue;
      if (bar.classList.contains("hl-seg") || bar.classList.contains("hl-base"))
        continue;
      var row = bar.parentElement;
      if (!row) continue;
      var lv = rowNumericLeaves(row);
      if (lv.length < 3) continue;
      rows.push({
        row: row,
        bar: bar,
        priceLeaf: lv[0],
        sizeLeaf: lv[1],
        totalLeaf: lv[2],
        price: M.toNum(lv[0].textContent),
        levelSize: M.toNum(lv[1].textContent),
        total: M.toNum(lv[2].textContent),
        colorKey: lv[0].style.color || "",
        color: bar.style.backgroundColor,
      });
    }

    // --- match orders to bucket rows ---
    // With price grouping, the displayed row price is a bucket, not the exact
    // order price. Match each order to the nearest row within one tick, biased
    // to the side's bucket edge (bids floor, asks ceil). myOf maps a row to our
    // aggregated {sz, usd, cat} there.
    var tick = computeTick(rows);
    var rowByKey = {};
    rows.forEach(function (r) {
      if (r.price != null) rowByKey[String(r.price)] = r;
    });
    var myOf = new Map();
    state.index.forEach(function (entry) {
      var p = Number(entry.price);
      var side = entry.sides.has("buy") ? "buy" : "sell";
      // Exact price row first (the reliable common case); fall back to bucket
      // matching only when the book is grouped and no exact row exists.
      var r = rowByKey[entry.price] || matchRow(rows, p, tick, side);
      if (!r) return;
      var cat = M.primaryCat(entry);
      var cur = myOf.get(r.row) || { sz: 0, usd: 0, cat: "limit" };
      cur.sz += entry.sz;
      cur.usd += entry.sz * p;
      if (catRank(cat) > catRank(cur.cat)) cur.cat = cat;
      myOf.set(r.row, cur);
    });
    log("rows:", rows.length, "tick:", tick, "matched:", myOf.size);
    function myUnit(m) {
      return isQuote ? m.usd : m.sz;
    }
    function disp(v) {
      // USDC values are rounded to whole numbers; base sizes stay precise.
      return isQuote ? Math.round(v) : v;
    }

    // --- write: per-level size badge + distance-from-mid on our levels ---
    var mid = computeMid(rows);
    var count = 0;
    rows.forEach(function (r) {
      var m = myOf.get(r.row);
      if (!m) return;
      count++;
      try {
        addBadge(r.sizeLeaf, m.cat, disp(myUnit(m)), "Your order (" + m.cat + ")");
        if (mid && r.price != null) {
          var diff = r.price - mid;
          var absVal = M.sigFigs(Math.abs(diff), 2);
          var pct = M.sigFigs((diff / mid) * 100, 2);
          var d = document.createElement("span");
          d.className = "hl-dist hl-badge-" + m.cat;
          d.textContent = "$" + absVal + "(" + (pct > 0 ? "+" : "") + pct + "%)";
          d.title = "Distance from mid";
          r.row.appendChild(d); // positioned via CSS (left = end of price col)
        }
      } catch (e) {
        log("row badge error:", e && e.message);
      }
    });

    // group by side (price-cell color)
    var groups = {};
    rows.forEach(function (r) {
      (groups[r.colorKey] = groups[r.colorKey] || []).push(r);
    });

    Object.keys(groups).forEach(function (ck) {
      var g = groups[ck];

      // Cumulative walk (sorted by Total, away from the spread): writes the
      // Total-column partition badge on every row our cumulative reaches, and —
      // in cumulative mode — the bar tip. The Total column is always cumulative,
      // so this badge is shown in both modes.
      var sorted = g.slice().sort(function (a, b) {
        return a.total - b.total;
      });
      var cum = 0;
      var lastCat = "limit";
      for (var i = 0; i < sorted.length; i++) {
        var r = sorted[i];
        var m = myOf.get(r.row);
        if (m) {
          cum += myUnit(m);
          lastCat = m.cat;
        }
        if (cum > 0) {
          try {
            addBadge(r.totalLeaf, lastCat, disp(cum), "Your cumulative depth here");
            if (mode !== "level" && r.total > 0) {
              paintDepthSegment(r.row, r.bar, cum, r.total, lastCat);
            }
          } catch (e) {
            log("total/bar error:", e && e.message);
          }
        }
      }

      // Per-level mode: hide native cumulative bars, draw per-level bars, and
      // paint our per-level share on the tip.
      if (mode === "level") {
        var maxLevel = 0;
        g.forEach(function (r) {
          if (r.levelSize > maxLevel) maxLevel = r.levelSize;
        });
        if (maxLevel <= 0) return;
        g.forEach(function (r) {
          try {
            r.bar.classList.add("hl-hide-bar");
            if (!r.levelSize || r.levelSize <= 0) return;
            var base = document.createElement("div");
            base.className = "hl-base";
            base.style.backgroundColor = r.color || "rgb(120,120,120)";
            base.style.width = (r.levelSize / maxLevel) * 100 + "%";
            r.row.appendChild(base);
            var m = myOf.get(r.row);
            if (m) {
              paintDepthSegment(r.row, base, myUnit(m), r.levelSize, m.cat);
            }
          } catch (e) {
            log("per-level bar error:", e && e.message);
          }
        });
      }
    });

    return count;
  }

  var CAT_RANK = { trigger: 3, reduce: 2, limit: 1 };
  function catRank(c) {
    return CAT_RANK[c] || 0;
  }

  // The grouping tick = smallest gap between adjacent displayed prices. Falls
  // back to a tiny epsilon (exact match only) when it can't be determined.
  function computeTick(rows) {
    var ps = rows
      .map(function (r) {
        return r.price;
      })
      .filter(function (p) {
        return p != null && isFinite(p);
      })
      .sort(function (a, b) {
        return a - b;
      });
    var t = Infinity;
    for (var i = 1; i < ps.length; i++) {
      var d = ps[i] - ps[i - 1];
      if (d > 1e-12 && d < t) t = d;
    }
    return isFinite(t) ? t : 1e-9;
  }

  // Nearest row to price p within one tick, preferring the side's bucket edge
  // (bids round down to the row at/below p; asks round up to at/above p).
  function matchRow(rows, p, tick, side) {
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].price == null) continue;
      var d = rows[i].price - p;
      var ad = Math.abs(d);
      if (ad >= tick - 1e-9) continue;
      var penalty = 0;
      if (side === "buy" && d > 1e-9) penalty = tick;
      if (side === "sell" && d < -1e-9) penalty = tick;
      var score = ad + penalty;
      if (score < bestScore) {
        bestScore = score;
        best = rows[i];
      }
    }
    return best;
  }

  // Walk up from a price leaf to the row element: the child of a list whose
  // siblings (same tag) also contain numeric leaves. This is class-name
  // agnostic, so it survives Hyperliquid's obfuscated/minified markup.
  function findRow(leaf, hasNumeric) {
    var node = leaf;
    for (var i = 0; i < 8 && node.parentElement; i++) {
      var parent = node.parentElement;
      var sims = 0;
      var kids = parent.children;
      for (var k = 0; k < kids.length; k++) {
        if (kids[k].tagName === node.tagName && hasNumeric.has(kids[k])) sims++;
      }
      if (sims >= 5) return node;
      node = parent;
    }
    return leaf.parentElement || leaf;
  }

  var observer = null;

  function apply() {
    if (observer) observer.disconnect();
    try {
      clearHighlights(document);
      var count = 0;
      if (state.enabled) {
        var scan = collectNumericLeaves(document.body);
        var root = findOrderbookRoot(scan);
        try {
          count = renderBook(
            root,
            state.barMode === "level" ? "level" : "cumulative",
            scan.sizeIsQuote
          );
        } catch (e) {
          log("render error:", e && e.message);
        }
      }
      state.lastCount = count;
      publishStatus();
      log("applied highlights", count, "barMode:", state.barMode);
    } finally {
      startObserver();
    }
  }

  var applyTimer = null;
  function scheduleApply() {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(apply, 250);
  }

  function startObserver() {
    if (!document.body) return;
    if (!observer) {
      observer = new MutationObserver(function () {
        scheduleApply();
      });
    }
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // --- popup status ---------------------------------------------------------
  function publishStatus() {
    try {
      chrome.storage.local.set({
        status: {
          user: state.user,
          coin: activeCoin(),
          orders: state.index.size,
          highlighted: state.lastCount,
          ts: Date.now(),
        },
      });
    } catch (_) {}
  }

  // --- settings -------------------------------------------------------------
  function loadSettings(cb) {
    chrome.storage.local.get(
      { enabled: true, debug: false, barMode: "cumulative" },
      function (s) {
        state.enabled = s.enabled !== false;
        state.debug = s.debug === true;
        state.barMode = s.barMode === "level" ? "level" : "cumulative";
        if (cb) cb();
      }
    );
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue !== false;
      scheduleApply();
    }
    if (changes.debug) state.debug = changes.debug.newValue === true;
    if (changes.barMode) {
      state.barMode =
        changes.barMode.newValue === "level" ? "level" : "cumulative";
      log("barMode changed ->", state.barMode);
      scheduleApply();
    }
  });

  // --- boot -----------------------------------------------------------------
  function boot() {
    loadSettings(function () {
      sayHello();
      startObserver();
      scheduleApply();
      // Poll: refresh orders, follow coin changes from URL navigation.
      pollTimer = setInterval(function () {
        if (!isContextValid()) return shutdown();
        refreshOrders();
        if (!state.wsCoin) {
          // No WS coin yet; URL is our source of truth.
          rebuildIndex();
          scheduleApply();
        }
      }, 3000);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
