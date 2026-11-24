/* Change feed.
   After each successful load a row's tickets are compared with the previous load (kept in localStorage, so it
   works across restarts). Open tickets that appear are "added" and stay highlighted until opened or marked seen;
   open tickets that go to Done or drop off the row are logged with the reason. Bell + panel in the header. */

import { call } from "./api.js";
import { renderTickets } from "./board.js";
import { S, browseUrl, findRow, isTeam, opt } from "./state.js";
import { $, clock, esc, local } from "./util.js";

const LOG_MAX = 300;
const freshTtl = () => opt("freshDays") * 864e5;

let snaps = local.get("jpd.snaps", {}); // rowId -> {more, k: {KEY: {s, c, st, t}}}
let log = local.get("jpd.log", []);     // newest first: {id, at, row, name, kind, key, summary, type, detail, url, read}
let fresh = local.get("jpd.fresh", {}); // rowId -> {KEY: firstSeenMs}

const saveFresh = () => local.set("jpd.fresh", fresh);
function push(evs) {
  if (!evs.length) return;
  log = evs.concat(log).slice(0, LOG_MAX);
  local.set("jpd.log", log);
  paintBell();
}
const ev = (p, kind, key, x, detail) => ({
  id: Math.random().toString(36).slice(2), at: Date.now(), row: p.accountId, name: p.displayName, team: isTeam(p),
  url: x.url || browseUrl(key), kind, key, summary: x.s ?? x.summary ?? "", type: x.t ?? x.type ?? "",
  detail: detail || "", read: false,
});

export const feed = {
  /** Drop NEW marks older than the "Keep the NEW tag" setting. */
  expire() {
    const now = Date.now();
    for (const r in fresh) {
      for (const k in fresh[r]) if (now - fresh[r][k] > freshTtl()) delete fresh[r][k];
      if (!Object.keys(fresh[r]).length) delete fresh[r];
    }
    saveFresh();
  },
  isFresh: (row, key) => !!(fresh[row] && fresh[row][key]),
  freshCount: (row, issues) => issues.filter(i => feed.isFresh(row, i.key)).length,
  unread: () => log.filter(e => !e.read).length,

  /** Compare a row's new ticket list with the previous one. */
  diff(p, issues, more) {
    const id = p.accountId, prev = snaps[id], cur = {};
    for (const i of issues) cur[i.key] = { s: i.summary, c: i.cat, st: i.status, t: i.type };
    snaps[id] = { more: !!more, k: cur };
    local.set("jpd.snaps", snaps);
    if (!prev || prev.more || more) return; // first load is the baseline; a cut-off list can't be compared
    const evs = [], gone = [];
    for (const i of issues) {
      const was = prev.k[i.key];
      if (!was && i.cat !== "done") {
        evs.push(ev(p, "added", i.key, i, isTeam(p) ? "New unassigned ticket" : "Assigned · " + i.status));
        (fresh[id] = fresh[id] || {})[i.key] = Date.now();
      } else if (was && was.c !== "done" && i.cat === "done") {
        evs.push(ev(p, "done", i.key, i, "Moved to " + i.status));
      }
    }
    for (const k in prev.k) if (!cur[k] && prev.k[k].c !== "done") gone.push(k);
    saveFresh();
    push(evs);
    if (gone.length) explain(p, gone, prev.k);
  },

  /** The ticket was opened: no longer NEW. Returns whether anything changed. */
  seen(row, key) {
    if (!fresh[row] || !fresh[row][key]) return false;
    delete fresh[row][key];
    saveFresh();
    return true;
  },
  seenAll() { fresh = {}; saveFresh(); },
  markRead() {
    if (log.some(e => !e.read)) { log.forEach(e => { e.read = true; }); local.set("jpd.log", log); }
    paintBell();
  },
  clearLog() { log = []; local.set("jpd.log", log); paintBell(); },
  /** Row was added or its projects changed: start a new baseline instead of logging the difference. */
  reset(row) {
    delete snaps[row]; delete fresh[row];
    local.set("jpd.snaps", snaps); saveFresh();
  },
};

/** Why did these tickets leave the row? Look them up once more. */
async function explain(p, gone, was) {
  const found = {}, checked = new Set();
  const look = async keys => {
    const jql = `key in (${keys.map(k => `"${k}"`).join(", ")})`;
    const r = await call("issues_search", { jql, maxResults: keys.length });
    for (const i of r.issues) found[i.key] = i;
    keys.forEach(k => checked.add(k));
  };
  // One deleted or moved key fails the whole query, so fall back to asking key by key.
  try {
    await look(gone);
  } catch {
    await Promise.all(gone.map(k => look([k]).catch(e => {
      if (/does not exist|not exist/i.test((e && e.msg) || "")) checked.add(k);
    })));
  }
  push(gone.map(k => {
    const i = found[k];
    let why = checked.has(k) ? "Not found in Jira (deleted or moved)" : "Left the row (couldn't check why)";
    if (i) {
      if (i.cat === "done") why = "Moved to " + i.status;
      else if (isTeam(p)) why = i.assignee ? "Picked up by " + i.assignee : "Moved to another team";
      else if (!i.assignee) why = "Unassigned";
      else if (i.assignee !== p.displayName) why = "Reassigned to " + i.assignee;
      else why = "Moved out of the tracked projects";
    }
    return ev(p, "left", k, i || was[k], why);
  }));
  if (fresh[p.accountId]) { gone.forEach(k => delete fresh[p.accountId][k]); saveFresh(); }
}

/* ---------- bell + panel ---------- */

export function paintBell() {
  const n = feed.unread(), b = $("#bellBadge");
  b.hidden = !n;
  b.textContent = n > 99 ? "99+" : String(n);
  $("#bell").title = n ? `${n} new change${n === 1 ? "" : "s"} on the board` : "What changed on the board";
  if (!$("#npanel").hidden) paintPanel();
}

function dayLabel(ms) {
  const d = new Date(ms), today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

const MARK = { added: "+", done: "✓", left: "−" };

function eventHTML(e) {
  const url = e.url || browseUrl(e.key);
  const tag = url ? "a" : "div";
  const href = url ? `href="${esc(url)}" target="_blank" rel="noopener"` : "";
  return `<${tag} class="nev ${esc(e.kind)}${e.read ? "" : " unread"}" ${href} data-key="${esc(e.key)}" data-row="${esc(e.row)}">
    <span class="nk" aria-label="${esc(e.kind)}">${MARK[e.kind] || "·"}</span>
    <span class="minw0"><span class="nl1"><span class="nkey">${esc(e.key)}</span><span class="nsum">${esc(e.summary)}</span></span>
    <span class="nl2">${esc(e.name)} · ${esc(e.detail)}</span></span>
    <span class="ntime">${clock(e.at)}</span></${tag}>`;
}

function paintPanel() {
  const n = log.length;
  let h = `<div class="nhead"><h2>Changes</h2><span class="stamp">${n ? `${n} event${n === 1 ? "" : "s"}` : ""}</span></div><div class="nlist">`;
  if (!n) h += `<div class="nempty">Nothing yet. Tickets that join or leave a row between refreshes show up here.</div>`;
  let day = "";
  for (const e of log) {
    const dl = dayLabel(e.at);
    if (dl !== day) { day = dl; h += `<div class="nday">${esc(dl)}</div>`; }
    h += eventHTML(e);
  }
  h += `</div><div class="nfoot">
    <button class="btn ghost" type="button" id="nSeen" title="Remove the NEW highlight from every ticket">Clear highlights</button>
    <button class="btn ghost danger" type="button" id="nClear" ${n ? "" : "disabled"}>Clear log</button></div>`;
  $("#npanel").innerHTML = h;
}

function togglePanel(open) {
  const el = $("#npanel"), willOpen = open ?? el.hidden;
  if (willOpen === !el.hidden) return;
  if (willOpen) { paintPanel(); el.hidden = false; } else { el.hidden = true; feed.markRead(); }
  $("#bell").setAttribute("aria-expanded", String(willOpen));
}

export function initFeedPanel() {
  $("#bell").onclick = () => togglePanel();
  $("#npanel").addEventListener("click", e => {
    if (e.target.closest("#nSeen")) { feed.seenAll(); S.people.forEach(renderTickets); return; }
    if (e.target.closest("#nClear")) { feed.clearLog(); paintPanel(); return; }
    const a = e.target.closest("a.nev");
    if (a && feed.seen(a.dataset.row, a.dataset.key)) {
      const p = findRow(a.dataset.row);
      if (p) renderTickets(p);
    }
  });
  document.addEventListener("mousedown", e => {
    if (!$("#npanel").hidden && !e.target.closest(".bellwrap")) togglePanel(false);
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#npanel").hidden) togglePanel(false); });
}
