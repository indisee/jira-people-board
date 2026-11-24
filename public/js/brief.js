/* Ticket brief UI: a status slot at the end of every ticket row and a ✦ button in the header for any ticket key.
   Shows Claude's very short "what to do, is it ready for development" (backend: src-tauri/src/brief).
   Styles: css/brief.css. The board only reserves the last grid track of `.t` rows for the slot. */

import { call } from "./api.js";
import { browseUrl } from "./state.js";
import { copyText, esc, icon } from "./util.js";

const known = new Map();    // key -> brief
const pending = new Map();  // key -> Promise while Claude is working
const failed = new Map();   // key -> error message
const fromDisk = new Set(); // keys whose brief came from the saved file and hasn't been rechecked yet

const VERDICT = { yes: "✅ Ready for dev", partly: "🟡 Partly ready", no: "⛔ Not ready", unknown: "❔ Unclear" };
const LABEL = { yes: "Ready for dev", partly: "Partly ready", no: "Not ready", unknown: "Unclear" };
const GLYPH = { idle: "✦", loading: "", yes: "✓", partly: "!", no: "✕", unknown: "?", error: "⚠" };
const TIP = { idle: "Brief: what to do and is it ready (Claude)", loading: "Asking Claude…", ...LABEL, error: "Brief failed" };

const I = {
  copy: '<path d="M8 8h11v11H8z"/><path d="M5 16V5h11"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  yes: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  partly: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5v.5"/>',
  no: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/>',
  unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17v.5"/>',
  task: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  work: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17v.5"/>',
  spark: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
};
const svg = n => icon(I[n]);

function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

/* ---------- requests: one per key at a time; the rows and the card all follow it ---------- */

function request(key, force) {
  if (pending.has(key) && !force) return pending.get(key);
  failed.delete(key);
  const p = call("ticket_brief", { key, force })
    .then(d => { known.set(key, d); fromDisk.delete(key); return d; })
    .catch(e => { failed.set(key, e.msg); throw e; })
    .finally(() => {
      if (pending.get(key) === p) pending.delete(key);
      paintKey(key);
      if (current === key) show();
    });
  pending.set(key, p);
  paintKey(key);
  return p;
}

/* ---------- row slots ---------- */

function stateOf(key) {
  if (pending.has(key)) return "loading";
  if (failed.has(key)) return "error";
  return known.has(key) ? known.get(key).ready || "unknown" : "idle";
}

function paintSlot(slot, key) {
  const st = stateOf(key), d = known.get(key);
  slot.dataset.state = st;
  slot.textContent = GLYPH[st] ?? "?";
  slot.title = st === "error" ? `${TIP.error}: ${failed.get(key)}` : d && st !== "loading" ? `${TIP[st]} — ${d.todo || ""}` : TIP[st];
  slot.setAttribute("aria-label", `${TIP[st]} — brief for ${key}`);
}
const paintKey = key => document.querySelectorAll(`a.t[data-key="${CSS.escape(key)}"] > .tb-slot`).forEach(s => paintSlot(s, key));

function decorate(row) {
  if (row.querySelector(":scope > .tb-slot")) return;
  const s = document.createElement("span");
  s.className = "tb-slot";
  s.setAttribute("role", "button");
  s.tabIndex = 0;
  row.appendChild(s);
  paintSlot(s, row.dataset.key);
}

/* ---------- card ---------- */

let card = null, anchor = null, current = "";

function close() { card?.remove(); card = null; anchor = null; current = ""; }

function place() {
  if (!card || !anchor) return;
  const r = anchor.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
  const left = Math.min(Math.max(16, r.right - w), innerWidth - w - 16);
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
  card.style.left = left + scrollX + "px";
  card.style.top = top + scrollY + "px";
}

const section = (cls, ic, title, items) => (items?.length
  ? `<div class="tb-sec ${cls}"><h4>${svg(ic)}${title} <small>${items.length}</small></h4><ul>${items.map(s => `<li>${esc(s)}</li>`).join("")}</ul></div>`
  : "");

/* Footer: when Claude answered, which model, and the cost `claude -p` reports
   (API price; on a Claude subscription it counts toward usage limits instead). */
function meta(d) {
  const model = d.model ? `Claude ${d.model}` : "Claude";
  const cost = d.cost != null ? ` · ≈ $${Number(d.cost).toFixed(3)}` : "";
  return `<span title="Model and cost reported by claude -p for this answer. The cost is the API price; on a Claude subscription it counts toward your usage instead.">Answered ${esc(ago(d.at))} by ${esc(model)}${cost}</span>`;
}

function bodyHTML(k, st, d) {
  if (st === "loading") return `<div class="tb-wait"><span class="tb-spin"></span><span>Reading ${esc(k)} and asking Claude… usually ~10 s. You can close this: the row shows the result.</span></div>`;
  if (st === "error") return `<div class="tb-err">${esc(failed.get(k))}</div>`;
  if (!d) return `<div class="tb-wait">Type a ticket key and press Enter.</div>`;
  const r = LABEL[d.ready] ? d.ready : "unknown";
  const why = [d.gaps?.length && `${d.gaps.length} blocking`, d.checks?.length && `${d.checks.length} to check`].filter(Boolean).join(" · ");
  return `<div class="tb-verdict ${r}">${svg(r)}<b>${LABEL[r]}</b>${why ? `<span>· ${why}</span>` : ""}</div>
    ${d.todo ? `<div class="tb-sec"><h4>${svg("task")}What to do</h4><p class="tb-todo">${esc(d.todo)}</p></div>` : ""}
    ${section("", "work", "Work", d.steps)}
    ${section("box bad", "block", "Blocking", d.gaps)}
    ${section("box mid", "warn", "Worth checking", d.checks)}`;
}

/** Draw the card for `current` from the shared state. */
function show() {
  if (!card) return;
  const k = current, d = known.get(k), st = k ? stateOf(k) : "none";
  const ready = d && st !== "loading";
  const btn = (act, title, ic) => `<button class="tb-ib" type="button" data-act="${act}" title="${title}" aria-label="${title}">${svg(ic)}</button>`;
  card.innerHTML = `<div class="tb-top"><input value="${esc(k)}" placeholder="KEY-123" aria-label="Ticket key" spellcheck="false">
      ${d?.status ? `<span class="tb-status">${esc(d.status)}</span>` : ""}<span class="tb-sp"></span>
      ${ready ? btn("copy", "Copy", "copy") : ""}
      ${ready || st === "error" ? btn("refresh", "Ask Claude again", "refresh") : ""}
      ${btn("close", "Close (Esc)", "close")}</div>
    <div class="tb-title">${d ? `<a href="${esc(browseUrl(d.key) || "#")}" target="_blank" rel="noopener">${esc(d.summary)}</a>` : ""}</div>
    <div class="tb-body">${bodyHTML(k, st, d)}</div>${d && st !== "loading" && st !== "error" ? `<div class="tb-foot">${meta(d)}</div>` : ""}`;
  const input = card.querySelector("input");
  input.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value.trim().toUpperCase();
    if (!v) return;
    current = v;
    if (!known.has(v)) request(v, false).catch(() => {});
    show();
  });
  if (!k) setTimeout(() => input.focus(), 0);
  card.querySelector("[data-act=close]").onclick = close;
  card.querySelector("[data-act=refresh]")?.addEventListener("click", () => { request(k, true).catch(() => {}); show(); });
  card.querySelector("[data-act=copy]")?.addEventListener("click", e => copyBrief(d, e.currentTarget));
  place();
}

async function copyBrief(d, btn) {
  const t = [
    `${d.key} — ${d.summary}`, VERDICT[d.ready] || "", d.todo, ...(d.steps || []).map(s => "• " + s),
    ...(d.gaps?.length ? ["Blocking:", ...d.gaps.map(s => "• " + s)] : []),
    ...(d.checks?.length ? ["Worth checking:", ...d.checks.map(s => "• " + s)] : []),
  ].filter(Boolean).join("\n");
  if (!(await copyText(t))) return;
  btn.innerHTML = svg("check"); btn.classList.add("ok"); btn.title = "Copied";
  setTimeout(() => { btn.innerHTML = svg("copy"); btn.classList.remove("ok"); btn.title = "Copy"; }, 1200);
}

export function open(key, anchorEl) {
  key = String(key || "").trim().toUpperCase();
  if (card && current === key && key) { close(); return; }
  close();
  card = document.createElement("div");
  card.className = "tb-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Ticket brief");
  document.body.appendChild(card);
  anchor = anchorEl || document.querySelector("#briefBtn") || document.body;
  current = key;
  // First click on an idle row starts the brief. A saved one is rechecked once: the backend keeps it
  // if the ticket, model and prompt are unchanged, else redoes it.
  if (key && (!known.has(key) || fromDisk.has(key)) && !pending.has(key)) {
    fromDisk.delete(key);
    request(key, false).catch(() => {});
  }
  show();
}

export function initBrief() {
  // Slots on every ticket row, now and whenever the board redraws.
  const scan = root => root.querySelectorAll && root.querySelectorAll("a.t[data-key]").forEach(decorate);
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
    if (n.nodeType === 1) { if (n.matches("a.t[data-key]")) decorate(n); else scan(n); }
  }))).observe(document.querySelector("#rows"), { childList: true, subtree: true });
  scan(document);

  // Verdicts saved earlier (they survive restarts).
  call("brief_cache").then(c => {
    for (const [k, v] of Object.entries(c || {})) if (!known.has(k)) { known.set(k, v); fromDisk.add(k); }
    Object.keys(c || {}).forEach(paintKey);
  }).catch(() => {});

  // The row is a link: keep the click for the brief.
  const onSlot = e => {
    const s = e.target.closest?.(".tb-slot");
    if (!s) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault(); e.stopPropagation();
    const row = s.closest("a.t[data-key]");
    open(row.dataset.key, row);
  };
  document.addEventListener("click", onSlot, true);
  document.addEventListener("keydown", onSlot, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && card) close(); });
  document.addEventListener("mousedown", e => {
    if (card && !card.contains(e.target) && !e.target.closest(".tb-slot,#briefBtn")) close();
  });
  addEventListener("resize", place);

  const hb = document.querySelector("#briefBtn");
  hb.innerHTML = svg("spark");
  hb.addEventListener("click", e => { e.stopPropagation(); open("", hb); });
}
