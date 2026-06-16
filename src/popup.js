"use strict";

function short(addr) {
  if (!addr) return "—";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function render(status) {
  status = status || {};
  document.getElementById("wallet").textContent = short(status.user);
  document.getElementById("coin").textContent = status.coin || "—";
  document.getElementById("orders").textContent =
    status.orders === undefined ? "—" : status.orders;
  document.getElementById("highlighted").textContent =
    status.highlighted === undefined ? "—" : status.highlighted;
}

var toggle = document.getElementById("enabled");

chrome.storage.local.get({ enabled: true, status: {} }, function (s) {
  toggle.checked = s.enabled !== false;
  render(s.status);
});

toggle.addEventListener("change", function () {
  chrome.storage.local.set({ enabled: toggle.checked });
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local") return;
  if (changes.status) render(changes.status.newValue);
  if (changes.enabled) toggle.checked = changes.enabled.newValue !== false;
});
