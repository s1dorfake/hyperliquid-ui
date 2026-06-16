# Hyperliquid My-Order Highlighter

A Chrome extension (Manifest V3) that highlights the price levels in the
Hyperliquid orderbook where **your connected wallet** has open orders —
color-coded by order type, with a size badge on each level.

| Color  | Meaning              |
| ------ | -------------------- |
| Blue   | Resting limit order  |
| Amber  | Trigger / TP-SL      |
| Purple | Reduce-only          |

## How it works

- **`src/injected.js`** runs in the page's MAIN world at `document_start` and
  hooks `WebSocket` _before_ the app connects. It reads only the **stable**
  parts of the outgoing `subscribe` messages — your wallet address
  (`subscription.user`) and the currently displayed coin (`l2Book`
  `subscription.coin`). It does not touch the app's connection otherwise.
- **`src/background.js`** fetches your open orders from the documented
  `frontendOpenOrders` info endpoint (off-page, no CORS issues). We use this
  rather than parsing the WS payload because Hyperliquid documents those order
  fields as unstable.
- **`src/content.js`** matches each order's price to orderbook rows in the DOM
  and applies the highlight + badge. Row detection is **class-name agnostic**
  (it finds rows by structure: a price leaf inside a list of ≥5 numeric
  siblings), so it survives Hyperliquid's minified/obfuscated markup.
- **`src/match.js`** holds the pure price/order logic and is unit-tested.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** and select this folder.
4. Open <https://app.hyperliquid.xyz>, connect your wallet, and open a market.
   Levels where you have orders should tint within a few seconds.

The toolbar popup shows the detected wallet, coin, order count, and an on/off
toggle.

## Tests

```
node test/match.test.js
```

## Debugging / tuning

The DOM-matching heuristic is the one part that can need adjustment if
Hyperliquid restructures their orderbook. To see what it's doing:

1. Open DevTools console on the Hyperliquid tab.
2. Run: `chrome.storage.local.set({ debug: true })`
3. Reload. The content script logs wallet/coin detection, order counts, index
   size, and how many levels it highlighted (prefixed `[HL-highlighter]`).

Turn it off with `chrome.storage.local.set({ debug: false })`.

## Notes & limitations

- Read-only: uses public, address-keyed data. No private keys, no signing, no
  order placement.
- Only the **currently displayed coin** is highlighted (orders are filtered to
  the active market).
- If the orderbook is aggregated (lower precision via the book's sig-figs
  selector), an exact order price may not correspond to a visible row.
- Highlights refresh on order updates via a 3s poll and on every DOM change.
