// Ticket brief UI: a status slot at the end of every ticket row (people and teams) and a ✦ button in the header
// for any ticket key. Shows Claude's very short "what to do, is it ready for development".
// Self-contained: brings its own styles and talks to the backend directly (Tauri `ticket_brief` / `brief_cache`,
// or GET /api/brief and /api/brief/cache in the browser version). The page only reserves the last grid track
// of `.t` rows for the slot. Backends: src-tauri/src/brief.rs and brief/server.js.
// API: window.TicketBrief.open(key, anchorEl?), .close().
(() => {
  if (new URLSearchParams(location.search).get("view")) return; // not in the Settings window
  const TAURI = window.__TAURI__ && window.__TAURI__.core;
  const known = new Map();   // key -> brief
  const pending = new Map(); // key -> Promise while Claude is working
  const failed = new Map();  // key -> error message
  const fromDisk = new Set(); // keys whose brief came from the saved file and hasn't been rechecked yet

  const css = `
.tb-slot{justify-self:end;width:22px;height:22px;display:grid;place-items:center;border-radius:50%;border:1px solid transparent;background:transparent;color:var(--muted,#93a4ab);font:600 12px/1 system-ui,sans-serif;cursor:pointer;padding:0;box-sizing:border-box}
.tb-slot[data-state=idle]{opacity:0;color:var(--accent,#4fc1c9);font-size:13px}
.t:hover .tb-slot[data-state=idle],.tb-slot[data-state=idle]:focus-visible{opacity:1}
.tb-slot:hover{border-color:var(--accent,#4fc1c9)}
.tb-slot[data-state=yes]{background:var(--done-bg,#143323);color:var(--done,#6fd39a)}
.tb-slot[data-state=partly]{background:color-mix(in srgb,var(--warn,#a15c00) 16%,var(--surface,#fff));color:var(--warn,#a15c00)}
.tb-slot[data-state=no],.tb-slot[data-state=error]{background:var(--danger-bg,#3a1a18);color:var(--danger,#ff8a80)}
.tb-slot[data-state=unknown]{background:var(--surface-2,#1b272c)}
.tb-slot[data-state=loading]::before{content:"";width:12px;height:12px;box-sizing:border-box;border:2px solid var(--line,#2a383e);border-top-color:var(--accent,#4fc1c9);border-radius:50%;animation:tbspin .8s linear infinite}
@media (max-width:720px){.t .tb-slot{grid-column:4;grid-row:3}}
.tb-card{--tb-ok:var(--done,#1f7a45);--tb-mid:var(--warn,#a15c00);--tb-bad:var(--danger,#b3261e);position:absolute;z-index:40;width:min(480px,calc(100vw - 32px));background:var(--surface,#fff);color:var(--fg,#16232a);border:1px solid var(--line,#dbe2e5);border-radius:12px;box-shadow:0 18px 48px rgb(0 0 0 / .18);font-size:13.5px;line-height:1.5;overflow:hidden}
.tb-top{display:flex;align-items:center;gap:6px;padding:10px 10px 0 14px}
.tb-top input{width:118px;font:600 13px/1.2 var(--f-mono,ui-monospace,monospace);text-transform:uppercase;background:transparent;color:var(--accent,#0b6b73);border:1px solid transparent;border-radius:6px;padding:4px 6px;margin-left:-7px}
.tb-top input:hover{border-color:var(--line,#dbe2e5)}
.tb-top input:focus{outline:none;border-color:var(--accent,#0b6b73);background:var(--bg,#f5f7f8)}
.tb-status{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#5b6b73);background:var(--surface-2,#eef2f3);border-radius:4px;padding:2px 6px;white-space:nowrap}
.tb-sp{flex:1}
.tb-ib{width:30px;height:30px;display:grid;place-items:center;border:1px solid transparent;background:transparent;color:var(--muted,#5b6b73);border-radius:7px;cursor:pointer;padding:0}
.tb-ib:hover{background:var(--surface-2,#eef2f3);color:var(--fg,#16232a)}
.tb-ib svg{width:16px;height:16px}
.tb-ib.ok{color:var(--tb-ok)}
.tb-title{padding:2px 14px 12px;font-weight:600;font-size:14.5px;line-height:1.35}
.tb-title a{color:inherit;text-decoration:none}
.tb-title a:hover{text-decoration:underline}
.tb-body{padding:0 14px 14px;display:grid;gap:14px}
.tb-verdict{--c:var(--muted,#5b6b73);display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 12px;border-radius:8px;background:color-mix(in srgb,var(--c) 11%,var(--surface,#fff));border:1px solid color-mix(in srgb,var(--c) 28%,var(--surface,#fff))}
.tb-verdict.yes{--c:var(--tb-ok)} .tb-verdict.partly{--c:var(--tb-mid)} .tb-verdict.no{--c:var(--tb-bad)}
.tb-verdict svg{flex:none;width:17px;height:17px;color:var(--c)}
.tb-verdict b{color:var(--c);font-size:13px}
.tb-verdict span{color:var(--muted,#5b6b73);font-size:12.5px}
.tb-todo{margin:0;color:var(--fg,#16232a)}
.tb-sec h4{display:flex;align-items:center;gap:6px;margin:0 0 6px;font-size:12.5px;font-weight:650;color:var(--fg,#16232a)}
.tb-sec h4 svg{width:14px;height:14px;color:var(--c,var(--muted,#5b6b73))}
.tb-sec h4 small{font-weight:500;color:var(--muted,#5b6b73);font-size:12px}
.tb-sec ul{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.tb-sec li{position:relative;padding-left:16px}
.tb-sec li::before{content:"";position:absolute;left:3px;top:.62em;width:5px;height:5px;border-radius:50%;background:var(--c,var(--muted,#5b6b73))}
.tb-sec.box{padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--c) 7%,var(--surface,#fff));border:1px solid color-mix(in srgb,var(--c) 22%,var(--surface,#fff))}
.tb-sec.bad{--c:var(--tb-bad)} .tb-sec.mid{--c:var(--tb-mid)}
.tb-foot{padding:8px 14px;border-top:1px solid var(--line,#dbe2e5);color:var(--muted,#5b6b73);font-size:12px;background:var(--bg,#f5f7f8)}
.tb-err{color:var(--tb-bad);white-space:pre-wrap}
.tb-wait{display:flex;align-items:center;gap:10px;color:var(--muted,#5b6b73)}
.tb-spin{flex:none;width:14px;height:14px;box-sizing:border-box;border:2px solid var(--line,#2a383e);border-top-color:var(--accent,#4fc1c9);border-radius:50%;animation:tbspin .8s linear infinite}
@keyframes tbspin{to{transform:rotate(360deg)}}
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const VERDICT = { yes: "✅ Ready for dev", partly: "🟡 Partly ready", no: "⛔ Not ready", unknown: "❔ Unclear" };
  const GLYPH = { idle: "✦", loading: "", yes: "✓", partly: "!", no: "✕", unknown: "?", error: "⚠" };
  const TIP = { idle: "Brief: what to do and is it ready (Claude)", loading: "Asking Claude…", yes: "Ready for dev", partly: "Partly ready", no: "Not ready", unknown: "Unclear", error: "Brief failed" };
  const ago = iso => {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };

  async function call(cmd, args, url) {
    if (TAURI) {
      try { return await TAURI.invoke(cmd, args); }
      catch (e) { const m = String(e && e.message || e); throw new Error(m.startsWith("AUTH:") ? "Jira rejected the API token (check Settings)." : m); }
    }
    let r;
    try { r = await fetch(url); } catch { throw new Error("The local server isn't running. Start it with: node server.js"); }
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.message || `Request failed (${r.status})`);
    return b;
  }
  const fetchBrief = (key, force) => call("ticket_brief", { key, force }, `/api/brief?key=${encodeURIComponent(key)}${force ? "&force=1" : ""}`);

  /* ---------- row slots ---------- */
  const stateOf = key => pending.has(key) ? "loading" : failed.has(key) ? "error" : known.has(key) ? known.get(key).ready || "unknown" : "idle";
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
  const scan = root => root.querySelectorAll && root.querySelectorAll("a.t[data-key]").forEach(decorate);
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && (n.matches?.("a.t[data-key]") ? decorate(n) : scan(n)))))
    .observe(document.body, { childList: true, subtree: true });
  scan(document);

  // Verdicts saved earlier (they survive restarts).
  call("brief_cache", {}, "/api/brief/cache").then(c => {
    for (const [k, v] of Object.entries(c || {})) if (!known.has(k)) { known.set(k, v); fromDisk.add(k); }
    Object.keys(c || {}).forEach(paintKey);
  }).catch(() => {});

  // The row is a link: keep the click for the brief.
  const onSlot = e => {
    const s = e.target.closest(".tb-slot"); if (!s) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault(); e.stopPropagation();
    const row = s.closest("a.t[data-key]");
    open(row.dataset.key, row);
  };
  document.addEventListener("click", onSlot, true);
  document.addEventListener("keydown", onSlot, true);

  /* ---------- header button ---------- */
  const tools = document.querySelector("header .tools");
  if (tools) {
    const hb = document.createElement("button");
    hb.className = "btn icon"; hb.type = "button"; hb.id = "briefBtn";
    hb.title = "Brief any ticket by key (Claude)"; hb.setAttribute("aria-label", "Brief a ticket");
    hb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>`;
    hb.addEventListener("click", e => { e.stopPropagation(); open("", hb); });
    tools.insertBefore(hb, tools.querySelector("#refresh"));
  }

  /* ---------- requests ---------- */
  // One request per key at a time; the rows and the card all follow it.
  function request(key, force) {
    if (pending.has(key) && !force) return pending.get(key);
    failed.delete(key);
    const p = fetchBrief(key, force)
      .then(d => { known.set(key, d); fromDisk.delete(key); return d; })
      .catch(e => { failed.set(key, e.message || String(e)); throw e; })
      .finally(() => { if (pending.get(key) === p) pending.delete(key); paintKey(key); if (current === key) show(); });
    pending.set(key, p);
    paintKey(key);
    return p;
  }

  /* ---------- card ---------- */
  let card = null, anchor = null, current = "";
  function close() { card?.remove(); card = null; anchor = null; current = ""; }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && card) close(); });
  document.addEventListener("mousedown", e => { if (card && !card.contains(e.target) && !e.target.closest(".tb-slot,#briefBtn")) close(); });

  function place() {
    if (!card || !anchor) return;
    const r = anchor.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
    const left = Math.min(Math.max(16, r.right - w), innerWidth - w - 16);
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    card.style.left = left + scrollX + "px";
    card.style.top = top + scrollY + "px";
  }

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
    check2: '<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17v.5"/>',
  };
  const svg = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
  const LABEL = { yes: "Ready for dev", partly: "Partly ready", no: "Not ready", unknown: "Unclear" };
  const section = (cls, icon, title, items) => items?.length
    ? `<div class="tb-sec ${cls}"><h4>${svg(icon)}${title} <small>${items.length}</small></h4><ul>${items.map(s => `<li>${esc(s)}</li>`).join("")}</ul></div>` : "";
  // Footer: when Claude answered, which model, and the cost `claude -p` reports for the call
  // (API price; on a Claude subscription it counts toward usage limits instead of being billed).
  const meta = d => {
    const model = d.model ? `Claude ${d.model}` : "Claude";
    const cost = d.cost != null ? ` · ≈ $${Number(d.cost).toFixed(3)}` : "";
    return `<span title="Model and cost reported by claude -p for this answer. The cost is the API price; on a Claude subscription it counts toward your usage instead.">Answered ${esc(ago(d.at))} by ${esc(model)}${cost}</span>`;
  };

  // Draws the card for `current` from the shared state.
  function show() {
    if (!card) return;
    const k = current, d = known.get(k), st = k ? stateOf(k) : "none";
    const ready = d && st !== "loading";
    const top = `<div class="tb-top"><input value="${esc(k)}" placeholder="KEY-123" aria-label="Ticket key" spellcheck="false">
      ${d?.status ? `<span class="tb-status">${esc(d.status)}</span>` : ""}<span class="tb-sp"></span>
      ${ready ? `<button class="tb-ib" type="button" data-act="copy" title="Copy" aria-label="Copy">${svg("copy")}</button>` : ""}
      ${ready || st === "error" ? `<button class="tb-ib" type="button" data-act="refresh" title="Ask Claude again" aria-label="Ask Claude again">${svg("refresh")}</button>` : ""}
      <button class="tb-ib" type="button" data-act="close" title="Close (Esc)" aria-label="Close">${svg("close")}</button></div>
      <div class="tb-title">${d ? `<a href="${esc(link(d.key))}" target="_blank" rel="noopener">${esc(d.summary)}</a>` : ""}</div>`;
    let body, foot = "";
    if (st === "loading") body = `<div class="tb-wait"><span class="tb-spin"></span><span>Reading ${esc(k)} and asking Claude… usually ~10 s. You can close this: the row shows the result.</span></div>`;
    else if (st === "error") body = `<div class="tb-err">${esc(failed.get(k))}</div>`;
    else if (d) {
      const r = LABEL[d.ready] ? d.ready : "unknown";
      // Verdict on its own line (with what drives it), the task description as a separate section below.
      const why = [d.gaps?.length && `${d.gaps.length} blocking`, d.checks?.length && `${d.checks.length} to check`].filter(Boolean).join(" · ");
      body = `<div class="tb-verdict ${r}">${svg(r)}<b>${LABEL[r]}</b>${why ? `<span>· ${why}</span>` : ""}</div>
        ${d.todo ? `<div class="tb-sec"><h4>${svg("task")}What to do</h4><p class="tb-todo">${esc(d.todo)}</p></div>` : ""}
        ${section("", "work", "Work", d.steps)}
        ${section("box bad", "block", "Blocking", d.gaps)}
        ${section("box mid", "check2", "Worth checking", d.checks)}`;
      foot = `<div class="tb-foot">${meta(d)}</div>`;
    } else body = `<div class="tb-wait">Type a ticket key and press Enter.</div>`;
    card.innerHTML = top + `<div class="tb-body">${body}</div>` + foot;
    const input = card.querySelector("input");
    input.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = input.value.trim().toUpperCase();
      if (v) { current = v; if (!known.has(v)) request(v, false).catch(() => {}); show(); }
    });
    if (!k) setTimeout(() => input.focus(), 0);
    card.querySelector("[data-act=close]").onclick = close;
    card.querySelector("[data-act=refresh]")?.addEventListener("click", () => { request(k, true).catch(() => {}); show(); });
    card.querySelector("[data-act=copy]")?.addEventListener("click", e => copy(d, e.currentTarget));
    place();
  }

  function link(key) {
    const a = document.querySelector(`a.t[data-key="${CSS.escape(key)}"]`) || document.querySelector("a.t[href*='/browse/']");
    try { return `${new URL(a.href).origin}/browse/${key}`; } catch { return "#"; }
  }

  function copy(d, btn) {
    const t = [`${d.key} — ${d.summary}`, VERDICT[d.ready] || "", d.todo, ...(d.steps || []).map(s => "• " + s),
      ...(d.gaps?.length ? ["Blocking:", ...d.gaps.map(s => "• " + s)] : []),
      ...(d.checks?.length ? ["Worth checking:", ...d.checks.map(s => "• " + s)] : [])].filter(Boolean).join("\n");
    navigator.clipboard?.writeText(t).then(() => {
      btn.innerHTML = svg("check"); btn.classList.add("ok"); btn.title = "Copied";
      setTimeout(() => { btn.innerHTML = svg("copy"); btn.classList.remove("ok"); btn.title = "Copy"; }, 1200);
    }).catch(() => {});
  }

  function open(key, anchorEl) {
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
    // First click on an idle row starts the brief.
    // A saved one is rechecked once: the backend keeps it if the ticket, model and prompt are unchanged, else redoes it.
    if (key && (!known.has(key) || fromDisk.has(key)) && !pending.has(key)) { fromDisk.delete(key); request(key, false).catch(() => {}); }
    show();
  }
  addEventListener("resize", place);

  window.TicketBrief = { open, close };
})();
