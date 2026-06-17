# Hyperliquid My-Order Highlighter

Chrome extension (MV3) that marks where **your connected wallet** has open orders
in the Hyperliquid order book, and shows your share of the depth. Read-only —
public data, no keys, no signing. Works on perps, spot, and outcome markets.

## What it does

At each of your levels: a **size badge** (Size column), a **cumulative partition
badge** (Total column), and a **colored segment on the depth bar** for your share.

Color by order type: **blue** = limit, **amber** = trigger/TP-SL, **purple** = reduce-only.

Popup toggles:
- **Enabled** — on/off.
- **Per-level depth bars** — switch bars between cumulative (default) and
  per-level (a non-cumulative book view).
- **Debug logging** — `[HL-highlighter]` logs in the page console.

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open <https://app.hyperliquid.xyz>, connect wallet, open a market.

After code changes: hit **↻** on the extension card, then reload the page.

## Tests

```
node test/match.test.js
```

## How it works

- `src/injected.js` (MAIN world) hooks `WebSocket` to read your wallet + active coin.
- `src/background.js` fetches orders from the `frontendOpenOrders` endpoint (no CORS).
- `src/content.js` renders into the DOM, class-name-agnostically; matches orders to
  bucket rows so it works at any price grouping.
- `src/match.js` — pure price/order logic (unit-tested).
