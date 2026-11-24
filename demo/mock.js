// Fake backend for the demo page: stands in for window.__TAURI__ with made-up people, tickets, notes and briefs.
// Nothing here talks to Jira, Zoom or Claude. Every name, ticket and site is invented.
(() => {
  const DAY = 864e5, now = Date.now();
  const SITE = "https://acme.atlassian.net";
  const iso = daysAgo => new Date(now - daysAgo * DAY).toISOString();
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const dayBefore = n => { const d = new Date(now - n * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

  const people = [
    { accountId: "maya", displayName: "Maya Chen", email: "maya.chen@acme.example", avatarUrl: "", projects: [{ key: "APP", name: "Mobile App" }, { key: "PAY", name: "Payments" }], addedAt: 1 },
    { accountId: "daniel", displayName: "Daniel Okafor", email: "daniel.okafor@acme.example", avatarUrl: "", projects: [{ key: "APP", name: "Mobile App" }, { key: "WEB", name: "Web" }], addedAt: 2 },
    { accountId: "sofia", displayName: "Sofia Marquez", email: "sofia.marquez@acme.example", avatarUrl: "", projects: [], addedAt: 3 },
    { accountId: "liam", displayName: "Liam Novak", email: "liam.novak@acme.example", avatarUrl: "", projects: [{ key: "WEB", name: "Web" }], addedAt: 4 },
    { accountId: "team:42", kind: "team", teamId: "42", displayName: "Platform", projects: [], addedAt: 5 },
  ];

  // [key, summary, status, category, type, priority, story points, opened days ago, owned days ago (null = since creation)]
  const T = {
    maya: [
      ["APP-412", "Offline mode: queue check-ins while there is no connection", "In Progress", "indeterminate", "Story", "High", 5, 12, 6],
      ["APP-431", "Crash on the trip details screen after rotating the device", "In Review", "indeterminate", "Bug", "Highest", 2, 4, 4],
      ["APP-398", "Accessibility labels for the booking flow", "To Do", "new", "Task", "Medium", 3, 33, 33],
      ["PAY-77", "Show the saved card's brand icon in checkout", "To Do", "new", "Story", "Low", 1, 2, null],
    ],
    daniel: [
      ["WEB-1203", "Migrate the account pages to the new design system", "In Progress", "indeterminate", "Story", "Medium", 8, 41, 38],
      ["APP-405", "Deep links to a booking open the home screen instead", "To Do", "new", "Bug", "High", 3, 9, 3],
      ["WEB-1219", "Cookie banner covers the footer links on small screens", "To Do", "new", "Bug", "Low", null, 1, null],
    ],
    sofia: [
      ["PAY-81", "Retry failed refunds automatically, up to three times", "In Progress", "indeterminate", "Story", "High", 5, 6, 5],
      ["DATA-19", "Nightly export of cancelled bookings for finance", "To Do", "new", "Task", "Medium", 3, 15, 15],
    ],
    liam: [
      ["WEB-1188", "Search results: keep filters when going back", "In Progress", "indeterminate", "Story", "Medium", 3, 20, 8],
      ["WEB-1201", "Upgrade the web build to the current Node LTS", "To Do", "new", "Task", "Low", 2, 18, 18],
    ],
    "team:42": [
      ["PLAT-233", "Rate-limit the public pricing API per client", "To Do", "new", "Story", "High", 5, 3, null],
      ["PLAT-229", "Alert when the booking queue is older than 5 minutes", "To Do", "new", "Task", "Medium", 2, 7, null],
    ],
  };
  const DONE = {
    maya: [["APP-390", "Remember the last used payment method", "Done", "done", "Story", "Medium", 3, 21, 14]],
    daniel: [["WEB-1190", "Broken layout of the invoice PDF in Safari", "Done", "done", "Bug", "High", 2, 10, 10]],
  };

  const issue = (who, [key, summary, status, cat, type, priority, sp, opened, owned]) => ({
    key, summary, status, cat, type, icon: "", priority, priorityIcon: "", sp,
    created: iso(opened), updated: iso(1), assignedAt: who.startsWith("team:") ? null : iso(owned ?? opened),
    assignedFromHistory: owned != null, assignee: who.startsWith("team:") ? "" : people.find(p => p.accountId === who).displayName,
    url: `${SITE}/browse/${key}`,
  });

  const notes = {
    [today]: {
      maya: { done: "Fixed the rotation crash (APP-431), PR is up", doing: "Offline queue: retry and conflict handling", at: now },
      daniel: { done: "Account settings page on the new components", doing: "APP-405 deep links\nPair with Liam on the search filters", at: now },
    },
    [dayBefore(1)]: {
      maya: { done: "Offline queue storage", doing: "APP-431", at: now - DAY },
      daniel: { done: "Profile page", doing: "Account settings page", at: now - DAY },
      sofia: { done: "Refund retry design", doing: "PAY-81 implementation", at: now - DAY },
      liam: { done: "Node LTS spike", doing: "Search filters", at: now - DAY },
    },
  };

  const BRIEFS = {
    "APP-412": { ready: "partly", todo: "Queue check-ins locally while offline and send them in order when the connection returns.",
      steps: ["Persist pending check-ins", "Replay queue on reconnect", "Show a pending badge on the trip"],
      gaps: ["Conflict rule when the trip changed meanwhile is undecided"], checks: ["Title says check-ins, a comment also mentions boarding passes"] },
    "APP-431": { ready: "yes", todo: "Keep the trip details state across rotation so the screen no longer crashes.", steps: ["Save the view model state", "Add a rotation UI test"], gaps: [], checks: [] },
    "WEB-1203": { ready: "no", todo: "Move the account pages to the new design system components.",
      steps: [], gaps: ["Blocked by WEB-1180 (In Progress)", "Designs for the billing page missing"], checks: [] },
    "PAY-81": { ready: "yes", todo: "Retry failed refunds automatically up to three times with backoff, then alert support.",
      steps: ["Retry job with backoff", "Alert after the third failure"], gaps: [], checks: ["Backoff interval: \"a few minutes\" — confirm the exact value"] },
    "PLAT-233": { ready: "partly", todo: "Add per-client rate limits to the public pricing API.", steps: ["Limit by API key", "Return 429 with Retry-After"],
      gaps: ["Limit values not agreed with Partners team"], checks: [] },
  };
  const all = Object.fromEntries(Object.values(T).flat().map(r => [r[0], r]));
  const brief = (key, ago = 0) => {
    const b = BRIEFS[key] || { ready: "yes", todo: "Implement the change described in the ticket.", steps: [], gaps: [], checks: [] };
    const r = all[key];
    return { ...b, key, summary: r ? r[1] : "Demo ticket", status: r ? r[2] : "To Do", at: new Date(now - ago * 60000).toISOString(),
      model: "sonnet", language: "English", cost: 0.021, ms: 9400, cached: false };
  };

  // The change feed lives in the page's localStorage: seed it so the bell has something to show.
  const seed = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* demo only */ } };
  const GONE = { "PAY-79": "Refund status in the order history", "WEB-1175": "Remove the legacy promo banner" };
  const ev = (row, name, kind, key, detail, minsAgo, read = false) => ({
    id: key + kind, at: now - minsAgo * 60000, row, name, team: row.startsWith("team:"), url: `${SITE}/browse/${key}`,
    kind, key, summary: all[key] ? all[key][1] : GONE[key] || "", type: "Story", detail, read,
  });
  try { localStorage.clear(); } catch { /* demo only */ }
  seed("jpd.log", [
    ev("maya", "Maya Chen", "added", "PAY-77", "Assigned · To Do", 25),
    ev("team:42", "Platform", "added", "PLAT-233", "New unassigned ticket", 70),
    ev("sofia", "Sofia Marquez", "left", "PAY-79", "Reassigned to Daniel Okafor", 190, true),
    ev("liam", "Liam Novak", "done", "WEB-1175", "Moved to Done", 60 * 26, true),
  ]);
  seed("jpd.fresh", { maya: { "PAY-77": now - 25 * 60000 }, "team:42": { "PLAT-233": now - 70 * 60000 } });
  seed("jpd.collapsed", ["liam"]);
  seed("jpd.zoomSent", {});

  let memo = "• Release 4.2 code freeze on Thursday\n• Ask Platform about the pricing API limits";
  let prompt = "";
  fetch("../src-tauri/src/brief/prompt.md").then(r => r.text()).then(t => { prompt = t; }).catch(() => {});

  const H = {
    config_get: () => ({
      settings: { site: SITE, spField: "customfield_10XXX", teamField: "customfield_10YYY" },
      effective: { envFile: "~/.jira-people-board.env", site: SITE, spField: "customfield_10XXX", teamField: "customfield_10YYY", teamClause: "cf[10YYY]" },
      defaults: { envFile: "~/.jira-people-board.env",
        briefModel: "sonnet", briefLanguage: "English", claudePath: "~/.local/bin/claude", briefPrompt: prompt },
      error: null, zoom: true,
    }),
    config_check: () => ({ user: "Demo User", email: "demo@acme.example", spName: "Story Points", teamName: "Team" }),
    config_save: () => H.config_get(),
    people_load: () => people,
    people_save: () => null,
    notes_load: () => notes,
    notes_put: () => null,
    memo_load: () => memo,
    memo_save: a => { memo = a.text; },
    issues_search: a => {
      const who = (people.find(p => a.jql.includes(`"${p.accountId}"`) || (p.teamId && a.jql.includes(`"${p.teamId}"`))) || {}).accountId;
      const withDone = /statusCategoryChangedDate/.test(a.jql);
      const rows = [...(T[who] || []), ...(withDone ? DONE[who] || [] : [])];
      return { issues: rows.map(r => issue(who, r)), more: false, url: `${SITE}/issues/` };
    },
    brief_cache: () => Object.fromEntries(Object.keys(BRIEFS).map((k, i) => [k, { ...brief(k, 40 + i * 30), cached: true }])),
    ticket_brief: a => new Promise(r => setTimeout(() => r(brief(a.key)), 1200)),
    users_search: () => [{ accountId: "noah", displayName: "Noah Fischer", email: "noah.fischer@acme.example", avatarUrl: "", active: true }],
    teams_search: () => [{ teamId: "43", displayName: "Data" }],
    projects_search: () => [{ key: "APP", name: "Mobile App" }, { key: "PAY", name: "Payments" }, { key: "WEB", name: "Web" }, { key: "DATA", name: "Data" }],
    zoom_send: () => "full",
    credentials_template: () => null,
    open_settings: () => { window.open("?view=settings", "settings", "width=600,height=780"); },
    "plugin:opener|open_url": a => { window.open(a.url, "_blank", "noopener"); },
    "plugin:dialog|open": () => null,
    "plugin:dialog|save": () => null,
  };

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (!H[cmd]) throw { kind: "other", message: `Not in the demo: ${cmd}` };
        return H[cmd](args || {});
      },
      convertFileSrc: () => "",
    },
    event: { listen: () => {} },
    window: { getCurrentWindow: () => ({ close: () => window.close() }) },
  };

  // ?shot=… opens the part of the page a README screenshot shows.
  const shot = new URLSearchParams(location.search).get("shot");
  window.__demoReady = () => setTimeout(() => {
    const $ = s => document.querySelector(s);
    if (shot === "brief") $('a.t[data-key="APP-412"] .tb-slot')?.click();
    if (shot === "changes") $("#bell")?.click();
    if (shot === "daily") $("#dailyBtn")?.click();
    if (new URLSearchParams(location.search).get("view") === "settings") document.activeElement?.blur();
    document.documentElement.dataset.ready = "1";
  }, 400);
})();
