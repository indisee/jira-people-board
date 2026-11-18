// Local Jira People Board: serves the page and proxies Jira REST with the token from ~/.release-script.env.
// Run: node server.js   → http://localhost:4317
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = Number(process.env.PORT) || 4317;
const DEFAULTS = {
  envFile: process.env.JIRA_ENV_FILE || path.join(os.homedir(), ".release-script.env"),
  site: "https://your-site.atlassian.net",
  spField: "customfield_10XXX",   // story points
  teamField: "customfield_10YYY", // Team
};
const SETTINGS_FILE = path.join(__dirname, "settings.json"); // what the Settings dialog saves
const DATA_FILE = path.join(__dirname, "people.json");
const NOTES_FILE = path.join(__dirname, "notes.json"); // daily notes: {"YYYY-MM-DD": {rowId: {done, doing, at}}}
const PAGE = path.join(__dirname, "public", "index.html");

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
const loadSettings = () => { try { const v = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
// "customfield_12345" -> "cf[12345]" for JQL; anything else is used as written.
const jqlClause = f => /^customfield_\d+$/.test(f) ? `cf[${f.slice(12)}]` : f;
const expandHome = p => p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;

// Current connection. Rebuilt when Settings are saved. Setting > environment variable > credentials file > default.
let cfg = {};
function configure() {
  const st = loadSettings(), pick = (sk, ek) => (String(st[sk] || "").trim()) || process.env[ek] || "";
  const ENV_FILE = expandHome(String(st.envFile || "").trim() || DEFAULTS.envFile);
  let env = {}, error = null;
  try { env = readEnv(ENV_FILE); } catch (e) { error = `Can't read ${ENV_FILE}: ${e.code || e.message}`; }
  const get = (sk, ek, d) => pick(sk, ek) || env[ek] || d;
  const EMAIL = env.ATLASSIAN_EMAIL, TOKEN = env.ATLASSIAN_API_TOKEN;
  if (!error && (!EMAIL || !TOKEN)) error = `ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN are missing in ${ENV_FILE}`;
  const teamField = get("teamField", "JIRA_TEAM_FIELD", DEFAULTS.teamField);
  cfg = {
    settings: st, error, ENV_FILE, EMAIL,
    SITE: get("site", "JIRA_SITE", DEFAULTS.site).replace(/\/+$/, ""),
    SP_FIELD: get("spField", "JIRA_SP_FIELD", DEFAULTS.spField),
    TEAM_FIELD: teamField, TEAM_CLAUSE: jqlClause(teamField),
    AUTH: EMAIL && TOKEN ? "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64") : "",
    ZOOM_URL: env.ZOOM_WEBHOOK_URL || "", ZOOM_TOKEN: env.ZOOM_WEBHOOK_TOKEN || "",
  };
  if (error) console.error(error);
}
configure();
const configView = () => ({
  settings: cfg.settings, error: cfg.error, zoom: !!(cfg.ZOOM_URL && cfg.ZOOM_TOKEN),
  effective: { envFile: cfg.ENV_FILE, site: cfg.SITE, spField: cfg.SP_FIELD, teamField: cfg.TEAM_FIELD, teamClause: cfg.TEAM_CLAUSE },
  defaults: DEFAULTS,
});

async function jira(pathAndQuery, init = {}) {
  if (cfg.error) { const err = new Error(cfg.error); err.status = 500; throw err; }
  const r = await fetch(cfg.SITE + pathAndQuery, {
    ...init,
    headers: { Authorization: cfg.AUTH, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 300) }; }
  if (!r.ok) {
    const msg = (body.errorMessages && body.errorMessages.join("; ")) || body.message || `Jira returned ${r.status}`;
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return body;
}

// When each issue was last assigned to `accountId`, from the bulk changelog (epoch ms by issue id).
// Issues with no assignee change were assigned at creation; the caller falls back to `created`.
async function assignedSince(ids, accountId) {
  const out = {};
  if (!ids.length) return out;
  let token;
  do {
    const r = await jira(`/rest/api/3/changelog/bulkfetch`, {
      method: "POST",
      body: JSON.stringify({ issueIdsOrKeys: ids, fieldIds: ["assignee"], maxResults: 1000, ...(token ? { nextPageToken: token } : {}) }),
    });
    for (const il of r.issueChangeLogs || []) {
      for (const h of il.changeHistories || []) {
        const t = Number(h.created) || Date.parse(h.created);
        if ((h.items || []).some(i => i.fieldId === "assignee" || i.field === "assignee") &&
            (h.items || []).some(i => (i.fieldId === "assignee" || i.field === "assignee") && i.to === accountId) &&
            (!out[il.issueId] || t > out[il.issueId])) out[il.issueId] = t;
      }
    }
    token = r.nextPageToken;
  } while (token);
  return out;
}

function send(res, status, obj, headers = {}) {
  const data = typeof obj === "string" || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ""; req.on("data", c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
const loadNotes = () => { try { const v = JSON.parse(fs.readFileSync(NOTES_FILE, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const loadPeople = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return []; } };

// Only proxy avatar images from Atlassian / Gravatar hosts.
const AVATAR_HOSTS = [/\.atlassian\.net$/, /\.atl-paas\.net$/, /^secure\.gravatar\.com$/, /^api\.atlassian\.com$/];
const avatarCache = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(PAGE));
    }
    if (url.pathname === "/api/people") {
      if (req.method === "GET") return send(res, 200, loadPeople());
      if (req.method === "PUT") {
        const list = await readBody(req);
        if (!Array.isArray(list)) return send(res, 400, { message: "Expected a list" });
        fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === "/api/notes") {
      if (req.method === "GET") return send(res, 200, loadNotes());
      if (req.method === "PUT") {
        const { day, id, done = "", doing = "" } = await readBody(req);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "") || !id) return send(res, 400, { message: "Expected day and id" });
        const all = loadNotes(), d = all[day] || {};
        if (!String(done).trim() && !String(doing).trim()) delete d[id];
        else d[id] = { done: String(done), doing: String(doing), at: Date.now() };
        if (Object.keys(d).length) all[day] = d; else delete all[day];
        const tmp = NOTES_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(all, null, 2)); fs.renameSync(tmp, NOTES_FILE);
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === "/api/config") {
      if (req.method === "GET") return send(res, 200, configView());
      if (req.method === "PUT") {
        const st = await readBody(req);
        if (!st || typeof st !== "object" || Array.isArray(st)) return send(res, 400, { message: "Expected an object" });
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(st, null, 2));
        configure(); avatarCache.clear();
        return send(res, 200, configView());
      }
    }
    if (req.method === "GET" && url.pathname === "/api/config/check") {
      const me = await jira(`/rest/api/3/myself`);
      const fields = await jira(`/rest/api/3/field`).catch(() => []);
      const nameOf = id => (fields.find(f => f.id === id) || {}).name || null;
      return send(res, 200, { user: me.displayName, email: me.emailAddress, spName: nameOf(cfg.SP_FIELD), teamName: nameOf(cfg.TEAM_FIELD) });
    }
    if (req.method === "POST" && url.pathname === "/api/zoom") {
      // Rich ("full") format first; plain text if Zoom rejects it.
      const { ZOOM_URL, ZOOM_TOKEN } = cfg;
      if (!ZOOM_URL || !ZOOM_TOKEN) return send(res, 400, { message: `ZOOM_WEBHOOK_URL / ZOOM_WEBHOOK_TOKEN are missing in ${cfg.ENV_FILE}` });
      if (!ZOOM_URL.startsWith("https://integrations.zoom.us/")) return send(res, 400, { message: "ZOOM_WEBHOOK_URL must be an https://integrations.zoom.us/ webhook" });
      const { full, text } = await readBody(req);
      const post = (format, body) => fetch(`${ZOOM_URL}?format=${format}`, { method: "POST", headers: { Authorization: ZOOM_TOKEN, "Content-Type": "application/json" }, body });
      let r = await post("full", JSON.stringify(full));
      if (r.ok) return send(res, 200, { format: "full" });
      r = await post("message", String(text || ""));
      if (r.ok) return send(res, 200, { format: "message" });
      return send(res, 502, { message: `Zoom returned ${r.status}: ${(await r.text()).slice(0, 200)}` });
    }
    if (req.method === "GET" && url.pathname === "/api/users") {
      const q = url.searchParams.get("q") || "";
      const users = await jira(`/rest/api/3/user/search?maxResults=20&query=${encodeURIComponent(q)}`);
      return send(res, 200, users.filter(u => u.accountType === "atlassian").map(u => ({
        accountId: u.accountId, displayName: u.displayName, email: u.emailAddress || "",
        avatarUrl: (u.avatarUrls && (u.avatarUrls["48x48"] || u.avatarUrls["32x32"])) || "", active: u.active,
      })));
    }
    if (req.method === "GET" && url.pathname === "/api/teams") {
      const q = url.searchParams.get("q") || "";
      const r = await jira(`/rest/api/3/jql/autocompletedata/suggestions?fieldName=${encodeURIComponent(cfg.TEAM_CLAUSE)}&fieldValue=${encodeURIComponent(q)}`);
      return send(res, 200, (r.results || []).map(t => ({ teamId: t.value, displayName: String(t.displayName || "").replace(/<[^>]*>/g, "") })));
    }
    if (req.method === "GET" && url.pathname === "/api/projects") {
      const q = url.searchParams.get("q") || "";
      const r = await jira(`/rest/api/3/project/search?maxResults=50&action=browse&orderBy=name&query=${encodeURIComponent(q)}`);
      return send(res, 200, (r.values || []).map(p => ({ key: p.key, name: p.name })));
    }
    if (req.method === "POST" && url.pathname === "/api/search") {
      const { jql, maxResults = 100, assignee } = await readBody(req);
      const r = await jira(`/rest/api/3/search/jql`, {
        method: "POST",
        body: JSON.stringify({ jql, maxResults, fields: ["summary", "status", "issuetype", "priority", "project", "created", "updated", "assignee", cfg.SP_FIELD] }),
      });
      const since = assignee ? await assignedSince((r.issues || []).map(n => n.id), assignee) : {};
      const params = new URLSearchParams({ jql });
      return send(res, 200, {
        issues: (r.issues || []).map(n => {
          const f = n.fields || {};
          return {
            key: n.key, summary: f.summary || "", status: (f.status && f.status.name) || "",
            cat: (f.status && f.status.statusCategory && f.status.statusCategory.key) || "new",
            type: (f.issuetype && f.issuetype.name) || "", icon: (f.issuetype && f.issuetype.iconUrl) || "",
            sp: typeof f[cfg.SP_FIELD] === "number" ? f[cfg.SP_FIELD] : null,
            created: f.created || "", updated: f.updated || "",
            assignedAt: since[n.id] ? new Date(since[n.id]).toISOString() : (assignee ? (f.created || "") : ""),
            assignedFromHistory: !!since[n.id],
            assignee: (f.assignee && f.assignee.displayName) || "",
            priority: (f.priority && f.priority.name) || "", priorityIcon: (f.priority && f.priority.iconUrl) || "",
            url: `${cfg.SITE}/browse/${n.key}`,
          };
        }),
        more: !r.isLast && !!r.nextPageToken,
        url: `${cfg.SITE}/issues/?${params}`,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/avatar") {
      const src = url.searchParams.get("u") || "";
      let target; try { target = new URL(src); } catch { return send(res, 400, { message: "Bad URL" }); }
      if (target.protocol !== "https:" || !AVATAR_HOSTS.some(rx => rx.test(target.hostname))) return send(res, 400, { message: "Host not allowed" });
      let hit = avatarCache.get(src);
      if (!hit || Date.now() - hit.at > 6 * 3600e3) {
        const needsAuth = /\.atlassian\.net$|^api\.atlassian\.com$/.test(target.hostname);
        const r = await fetch(src, { headers: needsAuth && cfg.AUTH ? { Authorization: cfg.AUTH } : {}, redirect: "follow" });
        if (!r.ok) return send(res, 404, { message: "No avatar" });
        hit = { at: Date.now(), type: r.headers.get("content-type") || "image/png", buf: Buffer.from(await r.arrayBuffer()) };
        avatarCache.set(src, hit);
      }
      res.writeHead(200, { "Content-Type": hit.type, "Cache-Control": "max-age=21600" });
      return res.end(hit.buf);
    }
    send(res, 404, { message: "Not found" });
  } catch (e) {
    send(res, e.status === 401 || e.status === 403 ? e.status : 502, { message: e.message || "Request to Jira failed" });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Jira People Board → http://localhost:${PORT}  (Jira: ${cfg.SITE}${cfg.EMAIL ? ", as " + cfg.EMAIL : ""})`));
