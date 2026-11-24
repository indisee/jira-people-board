/* Add a person or team (two steps: find them, pick projects), or edit a person's projects. */

import { call } from "./api.js";
import { avatarHTML, loadTickets, render } from "./board.js";
import { feed } from "./feed.js";
import { S, isTeam, store } from "./state.js";
import { openSheet } from "./ui.js";
import { $, debounce, esc, local } from "./util.js";

/* ---------- recent projects: last picks first, then the ones most used on the board ---------- */

function rememberProjects(list) {
  if (!list || !list.length) return;
  const keys = new Set(list.map(x => x.key));
  const rec = local.get("jpd.recentProjects", []).filter(x => !keys.has(x.key));
  local.set("jpd.recentProjects", [...list.map(x => ({ key: x.key, name: x.name })), ...rec].slice(0, 20));
}

function recentProjects() {
  const count = {}, names = {};
  for (const p of S.people) for (const x of (p.projects || [])) { count[x.key] = (count[x.key] || 0) + 1; names[x.key] = x.name; }
  const out = [], seen = new Set();
  const add = x => { if (!seen.has(x.key)) { seen.add(x.key); out.push(x); } };
  local.get("jpd.recentProjects", []).forEach(add);
  Object.keys(count).sort((a, b) => count[b] - count[a]).forEach(k => add({ key: k, name: names[k] }));
  return out.slice(0, 5);
}

/** A row was saved: new baseline for the change feed, then load it. */
function afterSave(p) {
  feed.reset(p.accountId);
  delete S.tickets[p.accountId];
  render();
  loadTickets(p);
}

export function openModal(existing) {
  const st = {
    step: existing ? 2 : 1, person: existing ? { ...existing } : null,
    projects: existing ? [...(existing.projects || [])] : [],
    userResults: [], projResults: [], loading: false, err: "",
  };
  const sh = openSheet({ head: `<div class="steps" id="msteps"></div>` });
  const toggleProject = x => {
    if (st.projects.some(y => y.key === x.key)) st.projects = st.projects.filter(y => y.key !== x.key);
    else st.projects.push({ key: x.key, name: x.name });
    paintPicked(); paintResults();
  };

  let userSeq = 0, projSeq = 0;
  const searchUsers = debounce(async q => {
    if (!q.trim()) { st.userResults = []; st.err = ""; paintResults(); return; }
    const seq = ++userSeq;
    st.loading = true; paintResults();
    try {
      const [users, teams] = await Promise.all([
        call("users_search", { q: q.trim() }),
        call("teams_search", { q: q.trim() }).catch(() => []),
      ]);
      if (seq !== userSeq) return;
      const teamRows = teams.slice(0, 10).map(t => ({ kind: "team", accountId: "team:" + t.teamId, teamId: t.teamId, displayName: t.displayName }));
      st.userResults = [...users, ...teamRows];
      st.err = "";
    } catch (e) {
      if (seq !== userSeq) return;
      st.err = e.msg; st.userResults = [];
    }
    st.loading = false; paintResults();
  }, 250);
  const searchProjects = debounce(async q => {
    const seq = ++projSeq;
    st.loading = true; paintResults();
    try {
      const r = await call("projects_search", { q: q.trim() });
      if (seq !== projSeq) return;
      st.projResults = r; st.err = "";
    } catch (e) {
      if (seq !== projSeq) return;
      st.err = e.msg; st.projResults = [];
    }
    st.loading = false; paintResults();
  }, 200);

  function paint() {
    sh.title.textContent = existing ? `Projects for ${existing.displayName}` : (st.step === 1 ? "Add a person or team" : "Pick projects");
    $("#msteps").textContent = existing
      ? "Leave empty to show tickets from every project."
      : `Step ${st.step} of 2 · ${st.step === 1 ? "Find a person or team in Jira" : "Choose which projects to track"}`;
    if (st.step === 1) {
      sh.body.innerHTML = `<label class="lbl" for="uq">Person or team</label>
        <input type="search" id="uq" placeholder="Name, email or team…" autocomplete="off">
        <div class="results" id="res"></div>`;
      sh.foot.innerHTML = `<button class="btn" type="button" id="mcancel">Cancel</button>`;
      $("#mcancel").onclick = sh.close;
      const inp = $("#uq");
      inp.focus();
      inp.oninput = () => searchUsers(inp.value);
      paintResults();
      return;
    }
    sh.body.innerHTML = `${existing ? "" : `<div class="selperson">${avatarHTML(st.person, "sm")}<strong>${esc(st.person.displayName)}</strong></div>`}
      <div id="recentWrap"></div>
      <label class="lbl">Selected projects</label>
      <div class="picked" id="picked"></div>
      <label class="lbl" for="pq">Find projects</label>
      <input type="search" id="pq" placeholder="Project name or key" autocomplete="off">
      <div class="results" id="res"></div>`;
    sh.foot.innerHTML = `${existing ? "" : `<button class="btn" type="button" id="mback">Back</button>`}
      <button class="btn" type="button" id="mcancel">Cancel</button>
      <button class="btn primary" type="button" id="msave">${existing ? "Save" : "Add to board"}</button>`;
    $("#mcancel").onclick = sh.close;
    if ($("#mback")) $("#mback").onclick = () => { st.step = 1; st.person = null; paint(); };
    $("#msave").onclick = async () => {
      const btn = $("#msave");
      btn.disabled = true; btn.textContent = "Saving…";
      const u = st.person;
      const p = {
        accountId: u.accountId, displayName: u.displayName, email: u.email || "",
        ...(isTeam(u) ? { kind: "team", teamId: u.teamId } : {}),
        avatarUrl: u.avatarUrl || "", projects: st.projects.map(x => ({ key: x.key, name: x.name })),
        addedAt: u.addedAt || Date.now(),
      };
      try {
        await store.save(p);
      } catch {
        btn.disabled = false; btn.textContent = "Couldn't save. Try again";
        return;
      }
      sh.close();
      rememberProjects(p.projects);
      afterSave(p);
    };
    const inp = $("#pq");
    inp.oninput = () => searchProjects(inp.value);
    paintPicked();
    searchProjects("");
  }

  function paintRecent() {
    const el = $("#recentWrap");
    if (!el) return;
    const rec = recentProjects();
    if (!rec.length) { el.innerHTML = ""; return; }
    const sel = new Set(st.projects.map(x => x.key));
    el.innerHTML = `<label class="lbl">Recent projects</label><div class="recent">${rec.map((x, i) => `
      <button type="button" class="rchip${sel.has(x.key) ? " on" : ""}" data-r="${i}" aria-pressed="${sel.has(x.key)}" title="${esc(x.name)}">
        <span class="rkey">${esc(x.key)}</span><span class="rname">${esc(x.name)}</span></button>`).join("")}</div>`;
    el.querySelectorAll("[data-r]").forEach(b => { b.onclick = () => toggleProject(rec[+b.dataset.r]); });
  }

  function paintPicked() {
    paintRecent();
    const el = $("#picked");
    if (!el) return;
    el.innerHTML = st.projects.length
      ? st.projects.map(x => `<span class="pchip" title="${esc(x.name)}">${esc(x.key)}<button type="button" data-rm="${esc(x.key)}" aria-label="Remove ${esc(x.key)}">×</button></span>`).join("")
      : `<span class="hint">None yet. With no projects selected, the board shows tickets from every project.</span>`;
    el.querySelectorAll("[data-rm]").forEach(b => { b.onclick = () => toggleProject({ key: b.dataset.rm }); });
  }

  function personResults(el) {
    const taken = new Set(S.people.map(p => p.accountId));
    const row = (u, i) => {
      const sub = isTeam(u) ? `<span class="rmail">Team · shows its unassigned tickets</span>` : u.email ? `<span class="rmail">${esc(u.email)}</span>` : "";
      const tag = taken.has(u.accountId) ? "On board" : u.active === false ? "Inactive" : "";
      return `<button class="res" type="button" data-i="${i}" ${taken.has(u.accountId) ? "disabled" : ""}>
        ${avatarHTML(u, "sm")}<span class="rn">${esc(u.displayName)}${sub}</span><span class="rk">${tag}</span></button>`;
    };
    const indexed = st.userResults.map((u, i) => [u, i]);
    const group = (title, list) => (list.length ? `<div class="rsec">${title}</div>` + list.map(([u, i]) => row(u, i)).join("") : "");
    if (st.userResults.length) {
      el.innerHTML = group("People", indexed.filter(([u]) => !isTeam(u))) + group("Teams", indexed.filter(([u]) => isTeam(u)));
    } else {
      const typed = $("#uq") && $("#uq").value.trim() && !st.loading;
      el.innerHTML = `<div class="hint">${typed ? "No people or teams in Jira match that." : "Search people by name or email, or teams by name."}</div>`;
    }
    el.querySelectorAll("[data-i]").forEach(b => {
      b.onclick = async () => {
        const u = st.userResults[+b.dataset.i];
        if (!isTeam(u)) { st.person = { ...u }; st.step = 2; paint(); return; }
        // Teams always cover every project: add right away, no project step.
        const p = { accountId: u.accountId, kind: "team", teamId: u.teamId, displayName: u.displayName, projects: [], addedAt: Date.now() };
        b.disabled = true;
        try {
          await store.save(p);
        } catch {
          b.disabled = false; st.err = "Couldn't add the team. Try again."; paintResults();
          return;
        }
        sh.close();
        afterSave(p);
      };
    });
  }

  function projectResults(el) {
    const sel = new Set(st.projects.map(x => x.key));
    el.innerHTML = st.projResults.length
      ? st.projResults.map((p, i) => `
        <button class="res${sel.has(p.key) ? " on" : ""}" type="button" data-i="${i}" aria-pressed="${sel.has(p.key)}">
          <span class="check">${sel.has(p.key) ? "✓" : ""}</span><span class="rn">${esc(p.name)}</span><span class="rk">${esc(p.key)}</span></button>`).join("")
      : (st.loading ? "" : `<div class="hint">No projects match that.</div>`);
    el.querySelectorAll("[data-i]").forEach(b => { b.onclick = () => toggleProject(st.projResults[+b.dataset.i]); });
  }

  function paintResults() {
    const el = $("#res");
    if (!el) return;
    if (st.err) { el.innerHTML = `<div class="cell-err">${esc(st.err)}</div>`; return; }
    const list = st.step === 1 ? st.userResults : st.projResults;
    if (st.loading && !list.length) { el.innerHTML = `<div class="skel"></div><div class="skel w70"></div>`; return; }
    if (st.step === 1) personResults(el); else projectResults(el);
  }

  paint();
}
