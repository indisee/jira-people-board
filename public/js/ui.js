// Page-level pieces shared by several features: the error banner and the dialog sheet.

import { $, esc } from "./util.js";

/** Banner over the board. `info` is a UiError (see api.js). Its buttons fire jpb:retry / jpb:settings. */
export function showBanner(info) {
  const b = $("#banner");
  b.className = "banner err";
  b.hidden = false;
  b.innerHTML = `<span>${esc(info.msg)}</span><span class="tools">
    ${info.settings ? `<button class="btn" type="button" data-banner="settings">Open settings</button>` : ""}
    <button class="btn" type="button" data-banner="retry">Try again</button></span>`;
}
export const hideBanner = () => { $("#banner").hidden = true; };
document.addEventListener("click", e => {
  const b = e.target.closest("[data-banner]");
  if (b) document.dispatchEvent(new Event("jpb:" + b.dataset.banner));
});

/** A dialog in #modalRoot. Closes on Escape and on a click outside. Returns its parts and `close`. */
export function openSheet({ title = "", head = "", wide = false }) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="scrim" id="scrim"><div class="modal${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="mtitle">
    <div class="mhead"><h2 id="mtitle">${esc(title)}</h2>${head}</div>
    <div class="mbody" id="mbody"></div><div class="mfoot" id="mfoot"></div></div></div>`;
  const onKey = e => { if (e.key === "Escape") close(); };
  const close = () => { root.innerHTML = ""; document.removeEventListener("keydown", onKey); };
  document.addEventListener("keydown", onKey);
  $("#scrim").addEventListener("mousedown", e => { if (e.target.id === "scrim") close(); });
  return { title: $("#mtitle"), head: $(".mhead"), body: $("#mbody"), foot: $("#mfoot"), close };
}

/* Images from Jira: hide the text fallback once the icon has loaded, drop the image if it fails.
   (Listeners here instead of onload/onerror attributes, which the CSP forbids.) */
document.addEventListener("load", e => {
  const img = e.target;
  if (img.tagName === "IMG" && img.dataset.fallback === "hide") img.parentNode.classList.add("img");
}, true);
document.addEventListener("error", e => {
  const img = e.target;
  if (img.tagName !== "IMG" || !img.dataset.fallback) return;
  img.parentNode && img.parentNode.classList.remove("img");
  img.remove();
}, true);
