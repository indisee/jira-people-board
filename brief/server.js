// Ticket brief: gathers a Jira ticket with its links, child tickets and comments, then asks `claude -p` for a very
// short "what to do and is it ready for development". This module stands on its own. The host passes in a Jira
// GET/POST function and a settings getter. Rust twin: src-tauri/src/brief.rs. Shared prompt: brief/prompt.md.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");

const PROMPT = path.join(__dirname, "prompt.md");
// briefPrompt: Settings can replace the built-in prompt (brief/prompt.md, read fresh so edits to it apply at once).
const DEFAULTS = { briefModel: "sonnet", briefLanguage: "English", claudePath: "", get briefPrompt() { return fs.readFileSync(PROMPT, "utf8"); } };
const LIMITS = { parentDesc: [6000, 2500], parentComments: 5, desc: 12000, comment: 1500, comments: 15, related: 600, children: 30, total: 60000 };

/* ---------- Jira → plain text ---------- */
// Atlassian Document Format → text. Paragraph-like nodes end lines; list items get "- ".
function adf(node, depth = 0) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(n => adf(n, depth)).join("");
  const kids = () => adf(node.content || [], depth + (node.type === "bulletList" || node.type === "orderedList" ? 1 : 0));
  switch (node.type) {
    case "text": return node.text || "";
    case "hardBreak": return "\n";
    case "mention": return node.attrs?.text || "@someone";
    case "emoji": return node.attrs?.text || node.attrs?.shortName || "";
    case "inlineCard": case "blockCard": case "embedCard": return (node.attrs?.url || "") + (node.type === "inlineCard" ? "" : "\n");
    case "status": return `[${node.attrs?.text || ""}]`;
    case "date": return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "mediaSingle": case "mediaGroup": case "media": return node.type === "media" ? "[image]\n" : kids();
    case "listItem": return "  ".repeat(Math.max(0, depth - 1)) + "- " + kids().trim() + "\n";
    case "taskItem": return (node.attrs?.state === "DONE" ? "[x] " : "[ ] ") + kids().trim() + "\n";
    case "heading": return "\n" + "#".repeat(node.attrs?.level || 2) + " " + kids().trim() + "\n";
    case "codeBlock": return "```\n" + kids() + "\n```\n";
    case "tableRow": return "| " + (node.content || []).map(c => adf(c.content || [], depth).trim().replace(/\n+/g, " ")).join(" | ") + " |\n";
    case "paragraph": case "blockquote": case "panel": case "table": case "bulletList": case "orderedList": case "taskList": case "expand": case "nestedExpand": case "doc": case "rule":
      return kids() + (node.type === "paragraph" ? "\n" : "");
    default: return kids();
  }
}
const text = v => (v && typeof v === "object" && v.type === "doc" ? adf(v) : typeof v === "string" ? v : "").replace(/\n{3,}/g, "\n\n").trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n) + " …[cut]" : s);
const day = s => (s ? String(s).slice(0, 10) : "");
const done = i => i?.fields?.status?.statusCategory?.key === "done";
const status = i => i?.fields?.status?.name || "?";

// Custom fields worth showing: rich text (acceptance criteria, notes…), names/values of options, plain text, links.
function customText(v) {
  if (v == null || v === "") return "";
  if (typeof v === "object" && v.type === "doc") return text(v);
  if (typeof v === "string") return /^\{.*=.*\}$/s.test(v) ? "" : v.trim(); // skip dev-panel blobs like "{pullrequest=…}"
  if (typeof v === "number" || typeof v === "boolean") return "";
  if (Array.isArray(v)) return v.map(customText).filter(Boolean).join(", ");
  return v.value || v.name || v.displayName || "";
}

const extraFields = (f, names, spField) => Object.entries(f)
  .filter(([k]) => k.startsWith("customfield_") && k !== spField && k !== "customfield_10020")
  .map(([k, v]) => [names[k] || k, customText(v)])
  .filter(([n, v]) => v && !/^(Rank|Team|Development|Start date|Sprint|Story point estimate|Flagged)$/i.test(n));

// Parent and grandparent (story → epic): children often keep the real requirements there.
async function ancestors(jira, f, spField) {
  const out = [];
  let p = f.parent;
  for (let level = 0; p && level < 2; level++) {
    let a;
    try { a = await jira(`/rest/api/3/issue/${encodeURIComponent(p.key)}?fields=*all&expand=names`); } catch { break; }
    const af = a.fields || {}, extra = extraFields(af, a.names || {}, spField);
    const comments = (af.comment?.comments || []).slice(-LIMITS.parentComments);
    out.push([
      `## ${level ? "Grandparent" : "Parent"} ticket: ${a.key} [${af.issuetype?.name || "?"} · ${af.status?.name || "?"}] ${af.summary || ""}`,
      "Description:\n" + (cut(text(af.description), LIMITS.parentDesc[level]) || "(empty)"),
      extra.length ? "Fields:\n" + extra.map(([n, v]) => `${n}: ${cut(v, 1500)}`).join("\n") : "",
      comments.length ? "Latest comments:\n" + comments.map(c => `- ${c.author?.displayName || "?"}, ${day(c.created)}: ${cut(text(c.body), 600)}`).join("\n") : "",
    ].filter(Boolean).join("\n"));
    p = af.parent;
  }
  return out;
}

async function collect(jira, key, spField) {
  const issue = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=*all&expand=names`);
  const f = issue.fields || {}, names = issue.names || {};
  const linkKeys = (f.issuelinks || []).map(l => (l.outwardIssue || l.inwardIssue)?.key).filter(Boolean);
  const search = (jql, max) => jira("/rest/api/3/search/jql", { method: "POST", body: JSON.stringify({ jql, maxResults: max, fields: ["summary", "status", "issuetype", "description", "assignee"] }) })
    .then(r => r.issues || []).catch(() => []);
  const [linked, children, parents] = await Promise.all([
    linkKeys.length ? search(`key in (${linkKeys.join(",")})`, linkKeys.length) : [],
    search(`parent = ${issue.key} ORDER BY key`, LIMITS.children),
    ancestors(jira, f, spField),
  ]);
  const byKey = Object.fromEntries(linked.map(i => [i.key, i]));
  const rel = i => `${i.key} [${i.fields?.issuetype?.name || "?"} · ${status(i)}${done(i) ? " ✓" : ""}] ${i.fields?.summary || ""}`;
  const relDesc = i => { const d = text(i?.fields?.description); return d ? "\n    " + cut(d, LIMITS.related).replace(/\n/g, "\n    ") : ""; };

  const out = [];
  out.push(`# ${issue.key}: ${f.summary || ""}`);
  const meta = [
    ["Type", f.issuetype?.name], ["Status", f.status?.name], ["Priority", f.priority?.name],
    ["Assignee", f.assignee?.displayName || "Unassigned"], ["Reporter", f.reporter?.displayName],
    ["Story points", f[spField]], ["Labels", (f.labels || []).join(", ")],
    ["Components", (f.components || []).map(c => c.name).join(", ")], ["Fix versions", (f.fixVersions || []).map(v => v.name).join(", ")],
    ["Sprint", Array.isArray(f.customfield_10020) ? f.customfield_10020.map(s => s.name).join(", ") : ""],
    ["Parent", f.parent ? `${f.parent.key} ${f.parent.fields?.summary || ""} (${f.parent.fields?.status?.name || "?"})` : ""],
    ["Created", day(f.created)], ["Updated", day(f.updated)], ["Due", day(f.duedate)],
  ].filter(([, v]) => v != null && v !== "");
  out.push(meta.map(([k, v]) => `${k}: ${v}`).join("\n"));
  out.push("## Description\n" + (cut(text(f.description), LIMITS.desc) || "(empty)"));

  const extra = extraFields(f, names, spField);
  if (extra.length) out.push("## Other fields\n" + extra.map(([n, v]) => `${n}: ${cut(v, 2000)}`).join("\n"));

  if ((f.attachment || []).length) out.push("## Attachments\n" + f.attachment.map(a => `- ${a.filename}`).join("\n"));

  out.push(...parents);
  if ((f.issuelinks || []).length) {
    out.push("## Linked tickets\n" + f.issuelinks.map(l => {
      const o = l.outwardIssue || l.inwardIssue, full = byKey[o?.key] || o;
      return `- ${l.outwardIssue ? l.type?.outward : l.type?.inward}: ${rel(full)}${relDesc(byKey[o?.key])}`;
    }).join("\n"));
  }
  if (children.length) out.push(`## Child tickets (${children.length})\n` + children.map(c => `- ${rel(c)}${relDesc(c)}`).join("\n"));

  const comments = (f.comment?.comments || []).slice(-LIMITS.comments);
  if (comments.length) out.push(`## Comments (latest ${comments.length} of ${f.comment.total ?? comments.length}, oldest first)\n` +
    comments.map(c => `- ${c.author?.displayName || "?"}, ${day(c.created)}: ${cut(text(c.body), LIMITS.comment)}`).join("\n"));

  return { issue, input: cut(out.join("\n\n"), LIMITS.total) };
}

/* ---------- claude -p ---------- */
// GUI-launched processes miss the login PATH: check the usual install spots, then ask the login shell.
function findClaude(custom) {
  if (custom) return custom.replace(/^~(?=\/)/, os.homedir());
  const home = os.homedir();
  for (const d of [path.join(home, ".local/bin"), path.join(home, ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    const p = path.join(d, "claude");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  try { return execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", "command -v claude"], { encoding: "utf8" }).trim().split("\n")[0] || null; } catch { return null; }
}

function runClaude({ exe, model, system, input, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--tools", "", "--output-format", "json", "--no-session-persistence", "--system-prompt", system];
    if (model) args.push("--model", model);
    // A neutral folder, so no project CLAUDE.md is pulled in.
    const cwd = path.join(os.tmpdir(), "jira-people-board-brief");
    fs.mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, PATH: [path.dirname(exe), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || ""].join(":") };
    const child = spawn(exe, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("claude took too long (timed out)")); }, timeoutMs);
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (err += d));
    child.on("error", e => { clearTimeout(timer); reject(new Error(`Couldn't start claude: ${e.message}`)); });
    child.on("close", code => {
      clearTimeout(timer);
      let env; try { env = JSON.parse(out.trim()); } catch {}
      if (!env) return reject(new Error((err || out).trim() || `claude exited with ${code}`));
      if (env.is_error) return reject(new Error(env.result || (env.errors && String(env.errors[0])) || `claude error (${env.subtype || "unknown"})`));
      resolve(env);
    });
    child.stdin.end(input);
  });
}

// The model is told to answer with bare JSON; tolerate a code fence or a sentence around it.
function parseAnswer(s) {
  const t = String(s || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const m = t.match(/\{[\s\S]*\}/);
  try {
    const v = JSON.parse(m ? m[0] : t);
    const list = x => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, 6) : []);
    return { ready: ["yes", "partly", "no"].includes(v.ready) ? v.ready : "unknown", todo: String(v.todo || ""), steps: list(v.steps), gaps: list(v.gaps), checks: list(v.checks) };
  } catch { return { ready: "unknown", todo: t, steps: [], gaps: [], checks: [] }; }
}

/* ---------- public API ---------- */
// createBrief({ jira, settings, cacheFile }) → { brief(key, {force}) }
//   jira(pathAndQuery, init) → Promise<json>    settings() → {briefModel, briefLanguage, claudePath, spField}
function createBrief({ jira, settings, cacheFile }) {
  const inflight = new Map();
  const readCache = () => { try { return JSON.parse(fs.readFileSync(cacheFile, "utf8")) || {}; } catch { return {}; } };
  const writeCache = c => { try { fs.writeFileSync(cacheFile, JSON.stringify(c, null, 1)); } catch {} };

  async function make(key, force) {
    const st = { ...DEFAULTS, ...Object.fromEntries(Object.entries(settings() || {}).filter(([, v]) => v !== "" && v != null)) };
    const { issue, input } = await collect(jira, key, st.spField);
    const head = { key: issue.key, summary: issue.fields?.summary || "", status: issue.fields?.status?.name || "", updated: issue.fields?.updated || "" };
    const system = String(st.briefPrompt).replaceAll("{{LANGUAGE}}", st.briefLanguage);
    const prompt = crypto.createHash("sha1").update(system).digest("hex").slice(0, 8);
    const cache = readCache(), hit = cache[issue.key];
    // Reuse while the ticket, model, language and prompt are unchanged. Refresh forces a new one.
    if (!force && hit && hit.updated === head.updated && hit.model === st.briefModel && hit.language === st.briefLanguage && hit.prompt === prompt) return { ...hit, cached: true };
    const exe = findClaude(st.claudePath);
    if (!exe) throw Object.assign(new Error("Claude Code CLI not found. Install it, or set its path in Settings → Claude path."), { status: 500 });
    const env = await runClaude({ exe, model: st.briefModel, system, input });
    const res = { ...head, ...parseAnswer(env.result), at: new Date().toISOString(), model: st.briefModel, language: st.briefLanguage, prompt, cost: env.total_cost_usd ?? null, ms: env.duration_ms ?? null };
    // Re-read right before writing: other briefs may have finished while Claude was working (sync, so no interleaving).
    const fresh = readCache(); fresh[issue.key] = res; writeCache(fresh);
    return { ...res, cached: false };
  }

  return {
    // Everything answered so far, so rows can show their verdict right after a restart.
    cached() { return readCache(); },
    brief(key, { force = false } = {}) {
      key = String(key || "").trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return Promise.reject(Object.assign(new Error("Not a ticket key"), { status: 400 }));
      const id = key + (force ? "!" : "");
      if (!inflight.has(id)) inflight.set(id, make(key, force).finally(() => inflight.delete(id)));
      return inflight.get(id);
    },
  };
}

module.exports = { createBrief, collect, parseAnswer, findClaude, DEFAULTS };
