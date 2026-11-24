/* The Settings window (index.html?view=settings), opened from App menu → Settings… (⌘,).
   Saving tells the board window through the "config-changed" event. */

import { call, closeWindow, pickFile, saveDialog } from "./api.js";
import { BOARD_DEFAULTS, S, opt } from "./state.js";
import { $, esc } from "./util.js";

const MODELS = [["sonnet", "Sonnet"], ["haiku", "Haiku"], ["opus", "Opus"]];

function formHTML() {
  const st = S.config.settings, d = S.config.defaults || {}, eff = S.config.effective || {};
  // Fields show the values in use (saved, else default); the default stays as the placeholder if a field is cleared.
  const cur = k => (k in BOARD_DEFAULTS ? opt(k) : (eff[k] ?? st[k] ?? d[k] ?? ""));
  const input = (k, ph, type, extra) =>
    `<input name="${k}" type="${type}" ${extra} value="${esc(cur(k))}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off">`;
  const field = (k, label, hint, ph, { type = "text", extra = "", side = "" } = {}) => `<label class="sfield"><span class="slabel">${label}</span>
    ${side ? `<span class="srow">${input(k, ph, type, extra)}${side}</span>` : input(k, ph, type, extra)}
    ${hint ? `<span class="shint">${hint}</span>` : ""}</label>`;
  // A saved model that isn't listed (e.g. a full model id) stays selectable.
  const model = String(cur("briefModel") || "sonnet");
  const models = MODELS.some(([id]) => id === model) ? MODELS : [...MODELS, [model, model]];
  const status = S.config.error
    ? `<span class="sbad">${esc(S.config.error)}</span>`
    : `In use: ${esc(eff.site || "")} · SP ${esc(eff.spField || "")} · Team ${esc(eff.teamField || "")}`;
  const envButtons = `<button class="btn" type="button" id="pickEnv">Choose…</button>
    <button class="btn" type="button" id="newEnv" title="Create an empty credentials file with all the fields, then open it for editing">New template…</button>`;

  return `<form id="setForm" class="sform">
    <h3 class="ssec">Jira connection</h3>
    ${field("envFile", "Credentials file", "Holds ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN (and the Zoom webhook). In the file dialog, ⇧⌘. shows hidden files.", d.envFile || "~/.release-script.env", { side: envButtons })}
    ${field("site", "Jira site", "Your Atlassian Cloud address. The API token is sent only there.", d.site || "https://your-site.atlassian.net", { type: "url" })}
    <h3 class="ssec">Custom fields</h3>
    <div class="sgrid">
      ${field("spField", "Story points field", "", d.spField || "customfield_10XXX")}
      ${field("teamField", "Team field", "", d.teamField || "customfield_10YYY")}
    </div>
    <div class="scheck"><button class="btn" type="button" id="setCheck">Check connection</button><span id="checkOut" class="shint" aria-live="polite">${status}</span></div>
    <h3 class="ssec">Board</h3>
    <div class="sgrid">
      ${field("refreshMinutes", "Auto-refresh, minutes", "0 turns it off", BOARD_DEFAULTS.refreshMinutes, { type: "number", extra: 'min="0" max="120" step="1"' })}
      ${field("maxResults", "Tickets per person, max", "", BOARD_DEFAULTS.maxResults, { type: "number", extra: 'min="10" max="100" step="10"' })}
      ${field("ownedWarnDays", "Highlight “Owned” after, days", "", BOARD_DEFAULTS.ownedWarnDays, { type: "number", extra: 'min="1" max="365"' })}
      ${field("freshDays", "Keep the NEW tag for, days", "", BOARD_DEFAULTS.freshDays, { type: "number", extra: 'min="1" max="60"' })}
    </div>
    <h3 class="ssec">Ticket brief (Claude)</h3>
    <div class="sgrid">
      <label class="sfield"><span class="slabel">Model</span>
        <select name="briefModel">${models.map(([id, n]) => `<option value="${esc(id)}"${id === model ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>
        <span class="shint">Sonnet is the default. Haiku is faster and cheaper, Opus is the most thorough.</span></label>
      ${field("briefLanguage", "Answer language", "", d.briefLanguage || "English")}
    </div>
    <label class="sfield"><span class="slabel srowlbl">Prompt <button class="btn ghost" type="button" id="promptReset" title="Put the built-in prompt back">Reset to default</button></span>
      <textarea name="briefPrompt" class="sprompt" rows="12" spellcheck="false">${esc(cur("briefPrompt") || d.briefPrompt || "")}</textarea>
      <span class="shint">What Claude is told for every ticket. It must keep asking for the same JSON (ready, todo, steps, gaps, checks). {{LANGUAGE}} becomes the answer language. Saved briefs are redone when the prompt changes.</span></label>
    ${field("claudePath", "Claude Code CLI", "Found automatically. Change it only if claude lives somewhere else.", d.claudePath || "claude")}
    <h3 class="ssec">Zoom</h3>
    <p class="shint">${S.config.zoom
      ? "✓ Webhook found in the credentials file (ZOOM_WEBHOOK_URL, ZOOM_WEBHOOK_TOKEN)."
      : "Add ZOOM_WEBHOOK_URL and ZOOM_WEBHOOK_TOKEN to the credentials file to send Daily notes to a Zoom channel."}</p>
  </form>`;
}

/** Only what differs from the defaults is saved, so a later default change still applies to untouched fields. */
function collect() {
  const d = S.config.defaults || {}, out = {};
  for (const el of $("#setForm").elements) {
    if (!el.name) continue;
    const v = el.value.trim();
    if (v === "") continue; // empty = default
    const val = el.type === "number" ? Number(v) : v;
    const def = el.name in BOARD_DEFAULTS ? BOARD_DEFAULTS[el.name] : d[el.name];
    if (def !== undefined && String(def).trim() === String(val).trim()) continue;
    out[el.name] = val;
  }
  return out;
}

export async function settingsWindow() {
  document.title = "Settings";
  $(".wrap").hidden = true;
  const page = document.createElement("div");
  page.className = "spage";
  page.innerHTML = `<div class="sbody"></div><div class="sfoot"></div>`;
  document.body.appendChild(page);
  try { S.config = await call("config_get"); } catch { /* the form still opens with defaults */ }

  page.querySelector(".sbody").innerHTML = formHTML();
  page.querySelector(".sfoot").innerHTML = `<span class="stamp push-left" id="setMsg" aria-live="polite"></span>
    <button class="btn" type="button" id="setCancel">Cancel</button><button class="btn primary" type="button" id="setSave">Save</button>`;
  const msg = $("#setMsg");
  const bad = t => `<span class="sbad">${esc(t)}</span>`;
  const field = name => $(`#setForm [name="${name}"]`);

  $("#setCancel").onclick = closeWindow;
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeWindow(); });
  $("#setForm").addEventListener("submit", e => { e.preventDefault(); $("#setSave").click(); });
  $("#setForm").addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); $("#setSave").click(); }
  });
  $("#promptReset").onclick = () => { const t = field("briefPrompt"); t.value = S.config.defaults.briefPrompt || ""; t.focus(); };

  $("#pickEnv").onclick = async () => {
    const inp = field("envFile");
    try {
      const picked = await pickFile({ title: "Choose the credentials file", multiple: false, directory: false,
        defaultPath: inp.value.trim() || S.config.defaults.envFile || undefined });
      if (typeof picked === "string" && picked) { inp.value = picked; inp.focus(); }
    } catch (e) { msg.innerHTML = bad(e.msg); }
  };
  $("#newEnv").onclick = async () => {
    try {
      const path = await saveDialog({ title: "Save the credentials template", defaultPath: "jira-people-board.env" });
      if (typeof path !== "string" || !path) return;
      await call("credentials_template", { path });
      field("envFile").value = path;
      msg.textContent = "Created and opened for editing. Fill it in, then Save here.";
    } catch (e) { msg.innerHTML = bad(e.msg); }
  };
  $("#setCheck").onclick = async () => {
    const o = $("#checkOut");
    o.textContent = "Checking…";
    try {
      const r = await call("config_check");
      const eff = S.config.effective;
      const f = (n, id) => (n ? `${esc(n)} ✓` : bad(`${id} not found`));
      o.innerHTML = `Connected as <b>${esc(r.user || "?")}</b> · Story points: ${f(r.spName, eff.spField)} · Team: ${f(r.teamName, eff.teamField)}`;
    } catch (e) { o.innerHTML = bad(e.msg); }
  };
  $("#setSave").onclick = async () => {
    const b = $("#setSave");
    if (b.disabled) return;
    b.disabled = true;
    msg.textContent = "Saving…";
    try {
      const next = await call("config_save", { settings: collect() });
      S.config = next;
      if (next.error) { msg.innerHTML = bad(next.error); return; }
      closeWindow();
    } catch (e) { msg.innerHTML = bad("Not saved: " + e.msg); } finally { b.disabled = false; }
  };
  const first = $("#setForm input");
  if (first) first.focus();
}
