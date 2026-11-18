// Local Jira People Board: serves the page and proxies Jira REST with the token from ~/.release-script.env.
// Run: node server.js   → http://localhost:4317
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = Number(process.env.PORT) || 4317;
const SITE = process.env.JIRA_SITE || "https://your-site.atlassian.net";
const ENV_FILE = process.env.JIRA_ENV_FILE || path.join(os.homedir(), ".release-script.env");
const SP_FIELD = process.env.JIRA_SP_FIELD || "customfield_10XXX"; // story points
const TEAM_CLAUSE = process.env.JIRA_TEAM_CLAUSE || "cf[10YYY]"; // Team field (customfield_10YYY)
const DATA_FILE = path.join(__dirname, "people.json");
const PAGE = path.join(__dirname, "public", "index.html");

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
const env = readEnv(ENV_FILE);
const EMAIL = env.ATLASSIAN_EMAIL, TOKEN = env.ATLASSIAN_API_TOKEN;
if (!EMAIL || !TOKEN) { console.error(`ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN missing in ${ENV_FILE}`); process.exit(1); }
const AUTH = "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");

async function jira(pathAndQuery, init = {}) {
  const r = await fetch(SITE + pathAndQuery, {
    ...init,
    headers: { Authorization: AUTH, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) },
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
      const r = await jira(`/rest/api/3/jql/autocompletedata/suggestions?fieldName=${encodeURIComponent(TEAM_CLAUSE)}&fieldValue=${encodeURIComponent(q)}`);
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
        body: JSON.stringify({ jql, maxResults, fields: ["summary", "status", "issuetype", "priority", "project", "created", "updated", "assignee", SP_FIELD] }),
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
            sp: typeof f[SP_FIELD] === "number" ? f[SP_FIELD] : null,
            created: f.created || "", updated: f.updated || "",
            assignedAt: since[n.id] ? new Date(since[n.id]).toISOString() : (assignee ? (f.created || "") : ""),
            assignedFromHistory: !!since[n.id],
            assignee: (f.assignee && f.assignee.displayName) || "",
            url: `${SITE}/browse/${n.key}`,
          };
        }),
        more: !r.isLast && !!r.nextPageToken,
        url: `${SITE}/issues/?${params}`,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/avatar") {
      const src = url.searchParams.get("u") || "";
      let target; try { target = new URL(src); } catch { return send(res, 400, { message: "Bad URL" }); }
      if (target.protocol !== "https:" || !AVATAR_HOSTS.some(rx => rx.test(target.hostname))) return send(res, 400, { message: "Host not allowed" });
      let hit = avatarCache.get(src);
      if (!hit || Date.now() - hit.at > 6 * 3600e3) {
        const needsAuth = /\.atlassian\.net$|^api\.atlassian\.com$/.test(target.hostname);
        const r = await fetch(src, { headers: needsAuth ? { Authorization: AUTH } : {}, redirect: "follow" });
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

server.listen(PORT, "127.0.0.1", () => console.log(`Jira People Board → http://localhost:${PORT}  (Jira: ${SITE}, as ${EMAIL})`));
