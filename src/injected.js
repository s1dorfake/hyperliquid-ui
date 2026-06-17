// Runs in the page's MAIN world at document_start.
// Hooks WebSocket BEFORE the Hyperliquid app opens its connection, so we can
// read the stable parts of the outgoing `subscribe` messages:
//   - the connected wallet address (subscription.user)
//   - the currently displayed coin   (l2Book subscription.coin)
// We deliberately do NOT parse the order payloads here (those fields are
// documented as unstable). Orders are fetched from the info endpoint instead.
(function () {
  "use strict";

  var lastUser = null;
  var lastCoin = null;

  // Subscription types that carry the currently-displayed market's coin.
  var COIN_CHANNELS = ["l2Book", "bbo", "activeAssetCtx", "candle"];

  function post(payload) {
    payload.__hlSource = "hl-injected";
    try {
      window.postMessage(payload, "*");
    } catch (_) {}
  }

  function handleOutgoing(data) {
    if (typeof data !== "string") return;
    var msg;
    try {
      msg = JSON.parse(data);
    } catch (_) {
      return;
    }
    var sub = msg && msg.subscription;
    if (!sub) return;

    // Diagnostic: surface every subscription so the content script can log it
    // in debug mode (helps identify which channel carries the active coin).
    post({ type: "sub", subType: sub.type, coin: sub.coin });

    if (typeof sub.user === "string" && /^0x[0-9a-fA-F]{40}$/.test(sub.user)) {
      if (sub.user !== lastUser) {
        lastUser = sub.user;
        post({ type: "user", user: lastUser });
      }
    }
    // The active coin shows up on several per-market channels. l2Book is the
    // orderbook itself; bbo/activeAssetCtx/candle also carry it and cover
    // markets (e.g. HIP-4 outcome markets) that don't use a plain l2Book sub.
    if (
      typeof sub.coin === "string" &&
      COIN_CHANNELS.indexOf(sub.type) !== -1
    ) {
      if (sub.coin !== lastCoin) {
        lastCoin = sub.coin;
        post({ type: "coin", coin: lastCoin });
      }
    }
  }

  // Handshake: the content script may load after we've already captured state.
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__hlSource !== "hl-content" || d.type !== "hello") return;
    if (lastUser) post({ type: "user", user: lastUser });
    if (lastCoin) post({ type: "coin", coin: lastCoin });
  });

  var OrigWS = window.WebSocket;
  if (!OrigWS) return;

  function PatchedWS(url, protocols) {
    var ws =
      arguments.length > 1 ? new OrigWS(url, protocols) : new OrigWS(url);
    try {
      var origSend = ws.send.bind(ws);
      ws.send = function (data) {
        try {
          handleOutgoing(data);
        } catch (_) {}
        return origSend(data);
      };
    } catch (_) {}
    return ws;
  }

  // Preserve prototype / static constants so the app keeps working normally.
  PatchedWS.prototype = OrigWS.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
    try {
      PatchedWS[k] = OrigWS[k];
    } catch (_) {}
  });

  try {
    window.WebSocket = PatchedWS;
  } catch (_) {}
})();
