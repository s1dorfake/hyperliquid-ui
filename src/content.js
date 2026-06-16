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
    orders: [],
    index: new Map(),
    lastCount: 0,
  };

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
    }
  });

  function sayHello() {
    window.postMessage({ __hlSource: "hl-content", type: "hello" }, "*");
  }

  // --- order fetching -------------------------------------------------------
  function refreshOrders() {
    if (!state.user) return;
    chrome.runtime.sendMessage(
      { type: "hl-fetch-orders", user: state.user },
      function (resp) {
        if (chrome.runtime.lastError) {
          log("fetch error", chrome.runtime.lastError.message);
          return;
        }
        if (!resp || !resp.ok) {
          log("fetch failed", resp && resp.error);
          return;
        }
        state.orders = resp.orders;
        log("orders", state.orders.length);
        rebuildIndex();
        scheduleApply();
      }
    );
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
    (root || document).querySelectorAll(".hl-badge").forEach(function (b) {
      b.remove();
    });
  }

  // Collect leaf elements whose text is a pure number, and mark all ancestors
  // (up to 8 levels) so we can recognize "rows" inside a list of >=5 siblings.
  function collectNumericLeaves(root) {
    var leaves = [];
    var hasNumeric = new Set();
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length !== 0) continue;
      if (el.closest(".hl-badge")) continue;
      if (!M.isNumberText(el.textContent)) continue;
      leaves.push(el);
      var a = el;
      for (var d = 0; d < 8 && a; d++) {
        hasNumeric.add(a);
        a = a.parentElement;
      }
    }
    return { leaves: leaves, hasNumeric: hasNumeric };
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
      if (state.enabled && state.index.size > 0) {
        var scan = collectNumericLeaves(document.body);
        for (var i = 0; i < scan.leaves.length; i++) {
          var leaf = scan.leaves[i];
          var key = M.priceKey(leaf.textContent);
          if (key === null) continue;
          var entry = state.index.get(key);
          if (!entry) continue;
          var row = findRow(leaf, scan.hasNumeric);
          if (!row || row.classList.contains("hl-myorder")) continue;
          var cat = M.primaryCat(entry);
          row.classList.add("hl-myorder", "hl-" + cat);
          var badge = document.createElement("span");
          badge.className = "hl-badge hl-badge-" + cat;
          badge.textContent = M.formatSz(entry.sz);
          badge.title =
            "Your open order @ " + entry.price + " (" + cat + ")";
          row.appendChild(badge);
          count++;
        }
      }
      state.lastCount = count;
      publishStatus();
      log("applied highlights", count);
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
    chrome.storage.local.get({ enabled: true, debug: false }, function (s) {
      state.enabled = s.enabled !== false;
      state.debug = s.debug === true;
      if (cb) cb();
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue !== false;
      scheduleApply();
    }
    if (changes.debug) state.debug = changes.debug.newValue === true;
  });

  // --- boot -----------------------------------------------------------------
  function boot() {
    loadSettings(function () {
      sayHello();
      startObserver();
      scheduleApply();
      // Poll: refresh orders, follow coin changes from URL navigation.
      setInterval(function () {
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
