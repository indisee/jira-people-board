// Entry point: the board window, or the Settings window (index.html?view=settings).

import { call, listen, openUrl } from "./api.js";
import { initBoard, loadAll, render, scheduleAuto } from "./board.js";
import { initBrief } from "./brief.js";
import { openDaily } from "./daily.js";
import { feed, initFeedPanel, paintBell } from "./feed.js";
import { initMemo } from "./memo.js";
import { S, store } from "./state.js";
import { settingsWindow } from "./settings.js";
import { hideBanner, showBanner } from "./ui.js";
import { $ } from "./util.js";

const showConfigError = () => showBanner({ msg: S.config.error + ". Fix it in Settings.", settings: true });

async function boot() {
  hideBanner();
  try { S.config = await call("config_get"); } catch { /* the banner below explains, if it matters */ }
  scheduleAuto();
  feed.expire();
  try { await store.init(); } catch (e) { render(); showBanner(e); return; }
  try { S.notes = await call("notes_load"); } catch { S.notes = {}; }
  render();
  paintBell();
  if (S.config.error) { showConfigError(); return; }
  loadAll();
}

/** New settings from the Settings window. */
function applyConfig(next) {
  const before = JSON.stringify(S.config.effective);
  S.config = next;
  scheduleAuto();
  feed.expire();
  if (S.config.error) { showConfigError(); return; }
  hideBanner();
  // New site or fields: reload everything; board-only changes just repaint.
  if (JSON.stringify(S.config.effective) !== before) {
    for (const k in S.tickets) delete S.tickets[k];
    render();
    loadAll();
  } else {
    render();
  }
}

function initBoardWindow() {
  initBoard();
  initFeedPanel();
  initBrief();
  initMemo();
  $("#dailyBtn").onclick = () => openDaily();
  document.addEventListener("jpb:retry", boot);
  document.addEventListener("jpb:settings", () => call("open_settings"));
  listen("config-changed", applyConfig);
  // Open Jira links in the default browser instead of inside the window.
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest('a[href^="https://"]');
    if (!a || e.defaultPrevented) return;
    e.preventDefault();
    openUrl(a.href).catch(err => showBanner({ msg: "Couldn't open the link in your browser: " + err.msg }));
  });
  boot();
}

if (new URLSearchParams(location.search).get("view") === "settings") settingsWindow();
else initBoardWindow();
