/* Daily notes: Done / Doing per person and day (notes.json), Next, History, the team's day view, Zoom report.
   The fields show today's entry, so they start empty every morning; earlier days stay in History. */

import { call } from "./api.js";
import { avatarHTML, render, renderRow, rowsEl } from "./board.js";
import { S, isTeam, saveCollapsed } from "./state.js";
import { openSheet } from "./ui.js";
import { $, clock, copyText, dayKey, esc, fmtDay, hslHex, hueOf, icon, local } from "./util.js";

const ICON_NEXT = icon(`<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>`);
const ICON_DONE = icon(`<path d="M20 6 9 17l-5-5"/>`);
const ICON_HISTORY = icon(`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`);

const noteOf = (id, day = S.today) => (S.notes[day] && S.notes[day][id]) || null;
const people = () => S.people.filter(p => !isTeam(p));
export const nextPerson = p => S.people.slice(S.people.indexOf(p) + 1).find(x => !isTeam(x)) || null;

export function dailyHTML(p) {
  const n = noteOf(p.accountId) || {};
  const next = nextPerson(p);
  const nextTip = next ? `Next: collapse and go to ${esc(next.displayName)}` : "Finish: collapse — this is the last person";
  return `<div class="daily">
    <textarea data-note="done" rows="1" aria-label="Done" placeholder="Done — what got finished">${esc(n.done || "")}</textarea>
    <textarea data-note="doing" rows="1" aria-label="Doing" placeholder="Doing — what's next today">${esc(n.doing || "")}</textarea>
    <div class="dactions">
      <button class="btn icon" type="button" data-act="next" aria-label="${next ? "Next person" : "Finish"}" title="${nextTip} (⌘/Ctrl + Enter)">${next ? ICON_NEXT : ICON_DONE}</button>
      <button class="btn icon" type="button" data-act="history" aria-label="History" title="History: this person's notes by date">${ICON_HISTORY}</button>
      <span class="dsaved" aria-live="polite"></span>
    </div></div>`;
}

export function grow(t) { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; }
export const growAll = root => root.querySelectorAll(".daily textarea").forEach(grow);

const saveTimers = {};
/** Save the row's note (debounced unless `now`). The in-memory copy updates at once, so a re-render never loses typing. */
export function queueSave(tr, p, now = false) {
  const done = tr.querySelector('[data-note="done"]').value, doing = tr.querySelector('[data-note="doing"]').value;
  const day = S.today, id = p.accountId;
  S.notes[day] = S.notes[day] || {};
  if (!done.trim() && !doing.trim()) delete S.notes[day][id]; else S.notes[day][id] = { done, doing, at: Date.now() };
  const flag = tr.querySelector(".dsaved");
  const say = t => { if (flag && flag.isConnected) flag.textContent = t; };
  const run = async () => {
    try { await call("notes_put", { day, id, done, doing }); say("Saved"); } catch (e) { say("Not saved: " + e.msg); }
  };
  clearTimeout(saveTimers[id]);
  say("…");
  if (now) run(); else saveTimers[id] = setTimeout(run, 600);
}

/** Collapse this person and open the next one, ready to type. */
export function goNext(p) {
  const nx = nextPerson(p), was = S.currentId;
  S.collapsed.add(p.accountId);
  if (nx) S.collapsed.delete(nx.accountId);
  S.currentId = nx ? nx.accountId : null;
  saveCollapsed();
  for (const id of new Set([p.accountId, was, nx && nx.accountId])) if (id) renderRow(id);
  const tr = nx && rowsEl().querySelector(`tr[data-id="${CSS.escape(nx.accountId)}"]`);
  if (!tr) return;
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  tr.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  const ta = tr.querySelector('[data-note="done"]');
  if (ta) ta.focus({ preventScroll: true });
}

// The day turned over while the app was open: show fresh fields (unless someone is typing).
setInterval(() => {
  if (dayKey() === S.today) return;
  if (document.activeElement && document.activeElement.matches(".daily textarea")) return;
  S.today = dayKey();
  render();
}, 60 * 1000);

const noteRows = n => ["done", "doing"].map(k => {
  const t = n[k].trim();
  return `<div class="hrow"><b>${k === "done" ? "Done" : "Doing"}</b><span class="${t ? "" : "none"}">${esc(t || "—")}</span></div>`;
}).join("");

export function openHistory(p) {
  const days = Object.keys(S.notes).filter(d => S.notes[d][p.accountId]).sort().reverse();
  const sh = openSheet({ title: `${p.displayName} · history` });
  sh.body.innerHTML = days.length
    ? days.map(d => `<div class="hday"><h3>${esc(fmtDay(d))}${d === S.today ? ` <span class="stamp">today</span>` : ""}</h3>${noteRows(S.notes[d][p.accountId])}</div>`).join("")
    : `<div class="empty">No notes for ${esc(p.displayName)} yet.</div>`;
  sh.foot.innerHTML = `<button class="btn" type="button" data-close>Close</button>`;
  sh.foot.querySelector("[data-close]").onclick = sh.close;
}

/* ---------- day text and the Zoom report ---------- */

const indent = t => t.trim().split(/\r?\n/).join("\n    ");

/** Plain text for the clipboard, with a "No notes" line. */
function dayText(day) {
  const d = S.notes[day] || {};
  const lines = [`Daily — ${fmtDay(day)}`, ""];
  for (const p of people()) {
    const n = d[p.accountId];
    if (!n) continue;
    lines.push(p.displayName);
    if (n.done.trim()) lines.push("  Done: " + indent(n.done));
    if (n.doing.trim()) lines.push("  Doing: " + indent(n.doing));
    lines.push("");
  }
  const missing = people().filter(p => !d[p.accountId]).map(p => p.displayName);
  if (missing.length) lines.push("No notes: " + missing.join(", "));
  return lines.join("\n").trim() + "\n";
}

/** Everyone with notes that day as a rich Zoom card (a stripe per person, bold name, ✅ / 🔜 lines), plus plain text. */
function zoomPayload(day) {
  const d = S.notes[day] || {}, ppl = people().filter(p => d[p.accountId]);
  // Zoom trims ordinary leading spaces, so lines under a name are indented with em spaces.
  const IND = "  ";
  const lines = (mark, t) => t.trim().split(/\r?\n/).map((l, i) => IND + (i ? "  " : mark + " ") + l.trim()).join("\n");
  const block = n => [n.done.trim() && lines("✅", n.done), n.doing.trim() && lines("🔜", n.doing)].filter(Boolean).join("\n");
  const body = ppl.map(p => ({
    type: "section",
    sidebar_color: hslHex(hueOf(p.accountId || p.displayName), 55, 40),
    sections: [
      { type: "message", text: p.displayName, style: { bold: true } },
      { type: "message", text: block(d[p.accountId]) },
    ],
  }));
  const full = { content: { head: { text: `Daily stand-up · ${fmtDay(day)}` }, body } };
  const text = [`📋 Daily stand-up · ${fmtDay(day)}`, ...ppl.map(p => `\n👤 ${p.displayName}\n${block(d[p.accountId])}`)].join("\n");
  return { full, text, count: ppl.length };
}

const zoomSent = () => local.get("jpd.zoomSent", {});
async function sendToZoom(day) {
  const { full, text } = zoomPayload(day);
  const format = await call("zoom_send", { full, text });
  local.set("jpd.zoomSent", { ...zoomSent(), [day]: Date.now() });
  return format;
}

export function openDaily(day = S.today) {
  const days = [...new Set([S.today, ...Object.keys(S.notes)])].sort().reverse();
  const opts = days.map(d => {
    const n = S.notes[d] ? ` · ${Object.keys(S.notes[d]).length}` : "";
    return `<option value="${esc(d)}">${esc(fmtDay(d))}${d === S.today ? " (today)" : ""}${n}</option>`;
  }).join("");
  const sh = openSheet({ title: "Daily notes", wide: true, head: `<div class="daynav">
      <button class="btn" type="button" id="dPrev" title="Earlier day" aria-label="Earlier day">‹</button>
      <select id="dSel" aria-label="Day">${opts}</select>
      <button class="btn" type="button" id="dNext" title="Later day" aria-label="Later day">›</button></div>` });

  const paint = () => {
    const d = S.notes[day] || {};
    const withN = people().filter(p => d[p.accountId]), missing = people().filter(p => !d[p.accountId]);
    sh.body.innerHTML = (withN.length
      ? withN.map(p => `<div class="hday"><h3>${avatarHTML(p)}${esc(p.displayName)}</h3>${noteRows(d[p.accountId])}</div>`).join("")
      : `<div class="empty">No notes for this day.</div>`)
      + (missing.length && withN.length ? `<div class="hmissing">No notes: ${missing.map(p => esc(p.displayName)).join(", ")}</div>` : "");
    $("#dSel").value = day;
    const i = days.indexOf(day);
    $("#dPrev").disabled = i >= days.length - 1;
    $("#dNext").disabled = i <= 0;
    const was = zoomSent()[day], off = withN.length ? "" : " disabled";
    sh.foot.innerHTML = `<span class="stamp push-left" id="dMsg" aria-live="polite">${was ? `Sent to Zoom at ${clock(was)}` : ""}</span>
      <button class="btn" type="button" data-close>Close</button>
      <button class="btn" type="button" id="dCopy"${off}>Copy</button>
      <button class="btn primary" type="button" id="dZoom"${off} title="Post this day's notes to the Zoom channel">${was ? "Send again" : "Send to Zoom"}</button>`;
    sh.foot.querySelector("[data-close]").onclick = sh.close;
    $("#dZoom").onclick = async () => {
      const b = $("#dZoom"), msg = $("#dMsg");
      b.disabled = true;
      msg.textContent = "Sending…";
      try {
        const f = await sendToZoom(day);
        msg.textContent = `Sent to Zoom${f === "message" ? " (as plain text)" : ""} · ${zoomPayload(day).count} people`;
        b.textContent = "Send again";
      } catch (e) {
        msg.textContent = "Not sent: " + e.msg;
      }
      b.disabled = false;
    };
    $("#dCopy").onclick = async () => {
      $("#dMsg").textContent = (await copyText(dayText(day))) ? "Copied to clipboard" : "Couldn't copy";
    };
  };
  const go = step => { day = days[days.indexOf(day) + step] || day; paint(); };
  $("#dSel").onchange = e => { day = e.target.value; paint(); };
  $("#dPrev").onclick = () => go(1);
  $("#dNext").onclick = () => go(-1);
  paint();
}
