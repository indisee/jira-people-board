/* The board: one row per person (or team), their tickets on the right, add-row at the bottom.
   Loading, rendering, reorder, folding, filters and auto-refresh. */

import { call, imgSrc } from "./api.js";
import { dailyHTML, goNext, grow, growAll, openHistory, queueSave } from "./daily.js";
import { feed } from "./feed.js";
import { openModal } from "./modal.js";
import { S, findRow, isTeam, opt, saveCollapsed, setDonePeriod, store } from "./state.js";
import { hideBanner, showBanner } from "./ui.js";
import { $, DAY, domId, esc, hueOf, initials } from "./util.js";

export const rowsEl = () => $("#rows");
const showDone = () => S.donePeriod > 0;

/* ---------- loading ---------- */

const quote = s => String(s).replace(/"/g, "");
function jqlFor(p) {
  const parts = isTeam(p)
    ? [`${S.config.effective.teamClause || "cf[10YYY]"} = "${quote(p.teamId)}"`, "assignee is EMPTY"]
    : [`assignee = "${quote(p.accountId)}"`];
  if (!isTeam(p) && p.projects && p.projects.length) {
    parts.push(`project in (${p.projects.map(x => `"${quote(x.key)}"`).join(", ")})`);
  }
  parts.push(S.donePeriod
    ? `(statusCategory != Done OR statusCategoryChangedDate >= -${S.donePeriod}d)`
    : "statusCategory != Done");
  return parts.join(" AND ") + " ORDER BY updated DESC";
}

/** Project key alphabetically, then issue number numerically (ABC-9 before ABC-10). */
function byKey(a, b) {
  const [pa, na] = a.key.split("-"), [pb, nb] = b.key.split("-");
  return pa.localeCompare(pb) || (Number(na) - Number(nb));
}

export async function loadTickets(p) {
  const id = p.accountId;
  S.tickets[id] = { ...(S.tickets[id] || {}), state: "loading" };
  renderTickets(p);
  try {
    const r = await call("issues_search", {
      jql: jqlFor(p), maxResults: opt("maxResults"), assignee: isTeam(p) ? null : id,
    });
    const issues = r.issues.sort(byKey);
    S.tickets[id] = { state: "ok", issues, more: r.more, url: r.url };
    feed.diff(p, issues, r.more);
    $("#stamp").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    S.tickets[id] = { ...(S.tickets[id] || {}), state: "err", err: e };
    if (e.page) showBanner(e);
  }
  renderTickets(p);
}

/** Run `fn` over `list` with at most `n` at a time. */
async function runPool(list, fn, n = 4) {
  const q = list.slice();
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}

let loadingAll = null;
/** Reload every row. A refresh that is already running is reused, not stacked. */
export function loadAll() {
  if (loadingAll) return loadingAll;
  hideBanner();
  const b = $("#refresh");
  b.classList.add("spinning");
  lastLoad = Date.now();
  loadingAll = runPool(S.people, loadTickets).finally(() => { b.classList.remove("spinning"); loadingAll = null; });
  return loadingAll;
}

/* ---------- icons and cells ---------- */

const projKey = i => i.key.split("-")[0];
/** Each project gets its own steady hue; spread so similar keys still look different. */
const projHue = key => (hueOf(key) * 137) % 360;

/** Fallback type marks when Jira's own icon can't load: colour + glyph per issue type, like Jira's. */
function typeMark(type) {
  const t = (type || "").toLowerCase();
  if (/bug|defect|incident/.test(t)) return { c: "#e5493a", g: "●" };
  if (/epic/.test(t)) return { c: "#904ee2", g: "⚡" };
  if (/story/.test(t)) return { c: "#63ba3c", g: "▮" };
  if (/improvement|feature/.test(t)) return { c: "#63ba3c", g: "↑" };
  if (/release/.test(t)) return { c: "#ff991f", g: "◆" };
  return { c: "#4bade8", g: "✓" };
}
function prioMark(name) {
  const n = (name || "").toLowerCase();
  if (/highest|blocker|critical|urgent|^p0$|^p1$/.test(n)) return { c: "#cd1317", g: "⇈" };
  if (/high|major|^p2$/.test(n)) return { c: "#e9494a", g: "↑" };
  if (/lowest|trivial|^p5$/.test(n)) return { c: "#0065ff", g: "⇊" };
  if (/low|minor|^p4$/.test(n)) return { c: "#2684ff", g: "↓" };
  return { c: "#e97f33", g: "=" };
}

/* Jira's icons are transparent SVGs: the text glyph shows until the image loads (ui.js handles load / error). */
function prioIcon(i) {
  if (!i.priority) return `<span class="pr" aria-hidden="true"></span>`;
  const m = prioMark(i.priority);
  const img = i.priorityIcon ? `<img src="${esc(imgSrc(i.priorityIcon))}" alt="" data-fallback="hide">` : "";
  return `<span class="pr" style="--pc:${m.c}" title="Priority: ${esc(i.priority)}" aria-label="Priority ${esc(i.priority)}"><span>${m.g}</span>${img}</span>`;
}
function typeIcon(i) {
  const m = typeMark(i.type);
  const img = i.icon ? `<img src="${esc(imgSrc(i.icon))}" alt="" data-fallback="drop">` : "";
  return `<span class="ti" style="--tc:${m.c}" title="${esc(i.type)}" aria-label="${esc(i.type)}"><span class="tg">${m.g}</span>${img}</span>`;
}

export function avatarHTML(p, cls = "") {
  const ini = esc(initials(p.displayName));
  if (isTeam(p)) return `<span class="avatar team ${cls}" style="--h:${hueOf(p.teamId)}" aria-hidden="true">${ini}</span>`;
  const img = p.avatarUrl ? `<img src="${esc(imgSrc(p.avatarUrl))}" alt="" data-fallback="drop">` : "";
  return `<span class="avatar ${cls}" style="--h:${hueOf(p.accountId || p.displayName)}" aria-hidden="true">${ini}${img}</span>`;
}

/* Ticket age: time since created, and time since it was last assigned to this person. */
const toMs = v => (typeof v === "number" ? v : Date.parse(v));
const dur = ms => (ms / DAY >= 0 ? Math.floor(ms / DAY) + "d" : "–");
function longDur(ms) {
  const d = Math.floor(ms / DAY);
  return d < 1 ? "less than a day" : d === 1 ? "1 day" : d + " days";
}
function ageCell(i, p) {
  const now = Date.now(), c = toMs(i.created), a = toMs(i.assignedAt);
  if (!c) return `<span class="age"></span>`;
  const day = ms => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  let tip = `Open ${longDur(now - c)} (created ${day(c)})`;
  if (a) tip += ` · On ${p.displayName} ${longDur(now - a)} (since ${day(a)}${i.assignedFromHistory ? "" : ", assigned at creation"})`;
  const stale = a && i.cat !== "done" && now - a > opt("ownedWarnDays") * DAY;
  return `<span class="age" title="${esc(tip)}"><span class="ao">${dur(now - c)}</span><span class="aa${stale ? " old" : ""}">${a ? dur(now - a) : "–"}</span></span>`;
}

const fmtSp = n => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ""));
const spBadge = i => (i.sp == null
  ? `<span class="sp none" title="No story points">–</span>`
  : `<span class="sp" title="${fmtSp(i.sp)} story points">${fmtSp(i.sp)}</span>`);
function spSum(iss) {
  const w = iss.filter(i => i.sp != null && i.cat !== "done");
  return { sum: w.reduce((a, i) => a + i.sp, 0), n: w.length };
}
const countOf = (iss, cat) => iss.filter(i => i.cat === cat).length;

/* ---------- rows ---------- */

function rowHTML(p) {
  const id = esc(domId(p.accountId)), isCol = S.collapsed.has(p.accountId), team = isTeam(p);
  const cls = [isCol && "collapsed", p.accountId === S.currentId && "current"].filter(Boolean).join(" ");
  const sub = team ? `<div class="pmail">Team · unassigned tickets</div>` : p.email ? `<div class="pmail">${esc(p.email)}</div>` : "";
  return `<tr data-id="${esc(p.accountId)}" class="${cls}">
    <td><div class="person">
      <button class="grip" type="button" data-act="grip" title="Drag to reorder, or focus and press ↑ / ↓" aria-label="Reorder ${esc(p.displayName)}">⋮⋮</button>
      ${avatarHTML(p)}
      <div class="minw0">
        <button class="pname ptoggle" type="button" data-act="toggle" aria-expanded="${!isCol}" title="${isCol ? "Expand" : "Collapse"}"><span class="chev" aria-hidden="true">▾</span>${esc(p.displayName)}</button>
        ${sub}
        <div class="pmeta" id="meta-${id}"></div>
        <div class="chips" id="chips-${id}"></div>
        <div class="pactions">
          ${team ? "" : `<button class="btn ghost" type="button" data-act="edit">Edit projects</button>`}
          <button class="btn ghost danger" type="button" data-act="remove">Remove</button>
        </div>
      </div></div>${team ? "" : dailyHTML(p)}</td>
    <td id="tk-${id}"></td></tr>`;
}

/** Redraw the whole table. */
export function render() {
  let html = S.people.length ? "" : `<tr class="emptyrow"><td colspan="2">No one on the board yet. Add a person and pick the projects to track their tickets.</td></tr>`;
  for (const p of S.people) html += rowHTML(p);
  html += `<tr class="addrow"><td colspan="2"><button class="addbtn" type="button" id="addBtn"><span class="plus">+</span> Add person or team</button></td></tr>`;
  rowsEl().innerHTML = html;
  S.people.forEach(renderTickets);
  growAll(rowsEl());
}

/** Redraw one row in place (fold / unfold, Next), keeping the rest of the table and its focus. */
export function renderRow(id) {
  const p = findRow(id), tr = rowsEl().querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  if (!p || !tr) return;
  tr.outerHTML = rowHTML(p);
  renderTickets(p);
  growAll(rowsEl().querySelector(`tr[data-id="${CSS.escape(id)}"]`));
}

/** Project chips under the avatar: same tint as the ticket rows, click to filter this row's list. */
function paintChips(p) {
  const el = document.getElementById("chips-" + domId(p.accountId));
  if (!el) return;
  const t = S.tickets[p.accountId], iss = (t && t.issues) || [];
  const counts = {};
  for (const i of iss) counts[projKey(i)] = (counts[projKey(i)] || 0) + 1;
  const names = Object.fromEntries((p.projects || []).map(x => [x.key, x.name]));
  const tracked = p.projects && p.projects.length;
  const keys = tracked ? p.projects.map(x => x.key) : Object.keys(counts).sort();
  const f = S.filters.get(p.accountId) || new Set();
  let h = keys.map(k => {
    const on = f.has(k), off = f.size && !on;
    const tip = `${names[k] || k}${on ? " · click to show all" : " · show only this project"}`;
    return `<button type="button" class="chip${on ? " on" : ""}${off ? " off" : ""}" style="--ph:${projHue(k)}" data-act="filter" data-key="${esc(k)}" aria-pressed="${on}" title="${esc(tip)}">${esc(k)}${t && t.issues ? `<span class="cn">${counts[k] || 0}</span>` : ""}</button>`;
  }).join("");
  if (!isTeam(p) && !tracked) h = `<span class="chip all">All projects</span>` + h;
  el.innerHTML = h;
}

function metaText(p, t, iss) {
  const prog = countOf(iss, "indeterminate"), done = countOf(iss, "done");
  const what = isTeam(p) ? "unassigned" : showDone() ? "tickets" : "open";
  return `${iss.length}${t.more ? "+" : ""} ${what}${done ? ` · ${done} done` : ""}${prog ? ` · ${prog} in progress` : ""}`;
}

function collapsedSummary(p, t, iss) {
  if (!iss.length) return `<button class="colsum" type="button" data-act="toggle">No tickets <span class="colhint">Show</span></button>`;
  const prog = countOf(iss, "indeterminate"), sp = spSum(iss), nf = feed.freshCount(p.accountId, iss);
  const keys = iss.slice(0, 6).map(i => esc(i.key)).join(", ") + (iss.length > 6 ? "…" : "");
  const parts = [
    `${iss.length}${t.more ? "+" : ""} tickets`,
    prog && `${prog} in progress`,
    sp.n && `${fmtSp(sp.sum)} SP`,
    nf && `<span class="nnew">${nf} new</span>`,
  ].filter(Boolean).join(" · ");
  return `<button class="colsum" type="button" data-act="toggle">${parts} <span class="colkeys">${keys}</span> <span class="colhint">Show</span></button>`;
}

function ticketHTML(i, prev, p) {
  const isNew = feed.isFresh(p.accountId, i.key);
  const cls = ["t", prev && projKey(i) !== projKey(prev) && "newproj", isNew && "fresh"].filter(Boolean).join(" ");
  return `<a class="${cls}" data-key="${esc(i.key)}" style="--ph:${projHue(projKey(i))}" href="${esc(i.url)}" target="_blank" rel="noopener" title="${esc(i.type)} · ${esc(i.summary)}">
    ${typeIcon(i)}${prioIcon(i)}<span class="k">${esc(i.key)}</span><span class="pill ${esc(i.cat)}">${esc(i.status)}</span>
    <span class="s">${isNew ? `<span class="newtag">New</span>` : ""}${esc(i.summary)}</span>${ageCell(i, p)}${spBadge(i)}</a>`;
}

export function renderTickets(p) {
  paintChips(p);
  const cell = document.getElementById("tk-" + domId(p.accountId));
  const meta = document.getElementById("meta-" + domId(p.accountId));
  if (!cell) return;
  const t = S.tickets[p.accountId];
  if (!t || (t.state === "loading" && !t.issues)) {
    cell.innerHTML = `<div class="skel"></div><div class="skel w80"></div><div class="skel w60"></div>`;
    return;
  }
  const retry = `<button class="btn" type="button" data-act="retry">Try again</button>`;
  if (t.state === "err" && !t.issues) {
    cell.innerHTML = `<div class="cell-err"><span>${esc(t.err.msg)}</span>${retry}</div>`;
    if (meta) meta.textContent = "";
    return;
  }
  const iss = t.issues || [];
  if (meta) {
    meta.textContent = metaText(p, t, iss);
    const nf = feed.freshCount(p.accountId, iss);
    if (nf) meta.insertAdjacentHTML("beforeend", ` · <span class="nnew">${nf} new</span>`);
  }
  if (S.collapsed.has(p.accountId)) { cell.innerHTML = collapsedSummary(p, t, iss); return; }

  const f = S.filters.get(p.accountId);
  const filtered = f && f.size;
  const shown = filtered ? iss.filter(i => f.has(projKey(i))) : iss;
  let h = "";
  if (t.state === "err") h += `<div class="cell-err above"><span>Showing earlier results. ${esc(t.err.msg)}</span>${retry}</div>`;
  if (!shown.length) {
    const what = isTeam(p) ? "unassigned tickets for this team" : "tickets assigned";
    h += `<div class="empty">No ${showDone() ? "" : "open "}${what} in ${filtered ? "the selected projects" : "these projects"}.</div>`;
  } else {
    h += `<div class="tickets">${shown.map((i, n) => ticketHTML(i, shown[n - 1], p)).join("")}</div>`;
  }
  if (t.more || (iss.length && t.url)) {
    h += `<div class="tfoot"><span>${t.more ? `Showing the ${opt("maxResults")} most recently updated.` : ""}</span>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">Open in Jira ↗</a>` : ""}</div>`;
  }
  cell.innerHTML = h;
}

/* ---------- reorder: drag the ⋮⋮ handle, or focus it and use ↑ / ↓ ---------- */

async function movePerson(id, toIndex) {
  const from = S.people.findIndex(p => p.accountId === id);
  if (from < 0) return;
  toIndex = Math.max(0, Math.min(S.people.length - 1, toIndex));
  if (from === toIndex) return;
  const [p] = S.people.splice(from, 1);
  S.people.splice(toIndex, 0, p);
  render();
  try { await store.persist(); } catch (e) { showBanner({ msg: "Couldn't save the new order: " + e.msg }); }
}

function initReorder(rows) {
  let dragId = null;
  const clearDrop = () => rows.querySelectorAll(".drop-before,.drop-after").forEach(r => r.classList.remove("drop-before", "drop-after"));
  rows.addEventListener("pointerdown", e => {
    const g = e.target.closest(".grip");
    if (g) g.closest("tr[data-id]").draggable = true;
  });
  rows.addEventListener("dragstart", e => {
    const tr = e.target.closest && e.target.closest("tr[data-id]");
    if (!tr || !tr.draggable) return;
    dragId = tr.dataset.id;
    tr.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", dragId); } catch { /* some engines refuse; not needed */ }
  });
  rows.addEventListener("dragover", e => {
    if (!dragId) return;
    const tr = e.target.closest("tr[data-id]");
    if (!tr || tr.dataset.id === dragId) { clearDrop(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = tr.getBoundingClientRect();
    clearDrop();
    tr.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
  });
  rows.addEventListener("drop", e => {
    if (!dragId) return;
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    e.preventDefault();
    const before = tr.classList.contains("drop-before");
    const id = dragId;
    const to = S.people.map(p => p.accountId).filter(x => x !== id).indexOf(tr.dataset.id) + (before ? 0 : 1);
    dragId = null;
    clearDrop();
    movePerson(id, to);
  });
  rows.addEventListener("dragend", () => {
    dragId = null;
    clearDrop();
    rows.querySelectorAll("tr[draggable]").forEach(r => { r.draggable = false; r.classList.remove("dragging"); });
  });
  rows.addEventListener("keydown", e => {
    const g = e.target.closest(".grip");
    if (!g || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const id = g.closest("tr[data-id]").dataset.id, i = S.people.findIndex(p => p.accountId === id);
    movePerson(id, i + (e.key === "ArrowUp" ? -1 : 1)).then(() => {
      const ng = rows.querySelector(`tr[data-id="${CSS.escape(id)}"] .grip`);
      if (ng) ng.focus();
    });
  });
}

/* ---------- row actions ---------- */

function toggleRow(p) {
  if (S.collapsed.has(p.accountId)) S.collapsed.delete(p.accountId); else S.collapsed.add(p.accountId);
  saveCollapsed();
  renderRow(p.accountId);
}

async function removeRow(p, btn) {
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = "1";
    btn.textContent = "Click to confirm";
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.confirm; btn.textContent = "Remove"; } }, 3500);
    return;
  }
  try {
    await store.remove(p.accountId);
    feed.reset(p.accountId);
    delete S.tickets[p.accountId];
    render();
  } catch {
    btn.textContent = "Couldn't remove";
  }
}

const ACTIONS = {
  toggle: toggleRow,
  filter(p, btn) {
    const f = S.filters.get(p.accountId) || new Set(), k = btn.dataset.key;
    if (f.has(k)) f.delete(k); else f.add(k);
    S.filters.set(p.accountId, f);
    renderTickets(p);
  },
  next(p, btn) { queueSave(btn.closest("tr"), p, true); goNext(p); },
  history: openHistory,
  edit: p => openModal(p),
  retry: loadTickets,
  remove: removeRow,
};

function setAllCollapsed(on) {
  S.collapsed = on ? new Set(S.people.map(p => p.accountId)) : new Set();
  saveCollapsed();
  render();
}

/* ---------- auto-refresh: every N minutes (Settings, 0 = off) while visible; catch up when it comes back ---------- */

const autoMs = () => opt("refreshMinutes") * 60 * 1000;
let lastLoad = Date.now(), autoTimer = null;
const autoLoad = () => { if (!document.hidden && S.people.length) loadAll(); };

export function scheduleAuto() {
  clearInterval(autoTimer);
  autoTimer = autoMs() > 0 ? setInterval(autoLoad, autoMs()) : null;
  const m = opt("refreshMinutes");
  $("#refresh").title = autoMs() > 0 ? `Refresh (also runs every ${m === 1 ? "minute" : m + " minutes"})` : "Refresh";
}

export function initBoard() {
  const rows = rowsEl();
  rows.addEventListener("click", e => {
    const link = e.target.closest("a.t.fresh");
    if (link) {
      const p = findRow(link.closest("tr[data-id]").dataset.id);
      if (p && feed.seen(p.accountId, link.dataset.key)) setTimeout(() => renderTickets(p), 0);
      return;
    }
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.id === "addBtn") { openModal(); return; }
    const tr = btn.closest("tr[data-id]"), p = tr && findRow(tr.dataset.id);
    const act = p && ACTIONS[btn.dataset.act];
    if (act) act(p, btn);
  });
  rows.addEventListener("input", e => {
    const t = e.target.closest(".daily textarea");
    if (!t) return;
    grow(t);
    const tr = t.closest("tr[data-id]"), p = findRow(tr.dataset.id);
    if (p) queueSave(tr, p);
  });
  rows.addEventListener("keydown", e => {
    const t = e.target.closest(".daily textarea");
    if (!t || e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    const tr = t.closest("tr[data-id]"), p = findRow(tr.dataset.id);
    if (p) { queueSave(tr, p, true); goNext(p); }
  });
  initReorder(rows);

  $("#refresh").onclick = () => loadAll();
  $("#foldAll").onclick = () => setAllCollapsed(true);
  $("#unfoldAll").onclick = () => setAllCollapsed(false);
  const dp = $("#donePeriod");
  dp.value = String(S.donePeriod);
  dp.onchange = () => { setDonePeriod(Number(dp.value) || 0); render(); loadAll(); };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && autoMs() > 0 && Date.now() - lastLoad >= autoMs()) autoLoad();
  });
  // The table head sticks right under the page header, whose height changes as the toolbar wraps.
  new ResizeObserver(([e]) => document.documentElement.style.setProperty("--hh", Math.round(e.target.getBoundingClientRect().height) + "px"))
    .observe($("header"));
}
