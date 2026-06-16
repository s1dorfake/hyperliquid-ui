// Service worker. Fetches open orders from Hyperliquid's documented info
// endpoint. Doing the fetch here (with host_permissions) avoids any CORS
// concerns and keeps the network call off the page.
"use strict";

var INFO_URL = "https://api.hyperliquid.xyz/info";

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== "hl-fetch-orders" || !msg.user) return;

  fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "frontendOpenOrders", user: msg.user }),
  })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (data) {
      sendResponse({ ok: true, orders: Array.isArray(data) ? data : [] });
    })
    .catch(function (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    });

  return true; // keep the message channel open for the async response
});
