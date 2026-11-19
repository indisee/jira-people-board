//! Ticket brief: gathers a Jira ticket with its links, child tickets and comments, then asks `claude -p` for a very
//! short "what to do and is it ready for development". This module stands on its own: it only needs a reqwest
//! client, the site and the auth header. Node twin: brief/server.js. Shared prompt: brief/prompt.md.

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

/// Built-in prompt; Settings → "Prompt" can replace it.
pub const DEFAULT_PROMPT: &str = include_str!("../../brief/prompt.md");
pub const DEFAULT_MODEL: &str = "sonnet";
pub const DEFAULT_LANGUAGE: &str = "English";
const DESC: usize = 12000;
const PARENT_DESC: [usize; 2] = [6000, 2500];
const PARENT_COMMENTS: usize = 5;
const COMMENT: usize = 1500;
const COMMENTS: usize = 15;
const RELATED: usize = 600;
const CHILDREN: usize = 30;
const TOTAL: usize = 60000;

/// Jira access the brief needs. The host builds it from its own connection.
pub struct Conn<'a> {
    pub client: &'a reqwest::Client,
    pub site: &'a str,
    pub auth: &'a str,
    pub sp_field: &'a str,
}

pub struct Options {
    /// System prompt; empty = DEFAULT_PROMPT. "{{LANGUAGE}}" is replaced with `language`.
    pub prompt: String,
    pub model: String,
    pub language: String,
    pub claude_path: String,
    pub cache_file: PathBuf,
    pub work_dir: PathBuf,
    pub force: bool,
}

impl Conn<'_> {
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        let mut rb = self
            .client
            .request(method, format!("{}{}", self.site, path))
            .header("Authorization", self.auth)
            .header("Accept", "application/json");
        if let Some(b) = body {
            rb = rb.json(&b);
        }
        let r = rb.send().await.map_err(|e| format!("Couldn't reach Jira: {e}"))?;
        let status = r.status();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("AUTH:Jira rejected the API token".into());
        }
        if !status.is_success() {
            let msg = v["errorMessages"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("; "))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("Jira returned {status}"));
            return Err(msg);
        }
        Ok(v)
    }
    async fn search(&self, jql: String, max: usize) -> Vec<Value> {
        let body = json!({ "jql": jql, "maxResults": max, "fields": ["summary", "status", "issuetype", "description", "assignee"] });
        self.call(reqwest::Method::POST, "/rest/api/3/search/jql", Some(body))
            .await
            .ok()
            .and_then(|r| r["issues"].as_array().cloned())
            .unwrap_or_default()
    }
}

/* ---------- Jira → plain text ---------- */

/// Atlassian Document Format → text. Paragraph-like nodes end lines; list items get "- ".
fn adf(n: &Value, depth: usize) -> String {
    if let Some(a) = n.as_array() {
        return a.iter().map(|x| adf(x, depth)).collect();
    }
    if let Some(s) = n.as_str() {
        return s.to_string();
    }
    if !n.is_object() {
        return String::new(); // missing "content" etc.: without this a leaf node (e.g. "rule") recursed forever
    }
    let t = n["type"].as_str().unwrap_or("");
    let attr = |k: &str| n["attrs"][k].as_str().unwrap_or("").to_string();
    let nested = if t == "bulletList" || t == "orderedList" { depth + 1 } else { depth };
    let kids = || adf(&n["content"], nested);
    match t {
        "text" => n["text"].as_str().unwrap_or("").to_string(),
        "hardBreak" => "\n".into(),
        "mention" => { let s = attr("text"); if s.is_empty() { "@someone".into() } else { s } }
        "emoji" => attr("text"),
        "inlineCard" => attr("url"),
        "blockCard" | "embedCard" => attr("url") + "\n",
        "status" => format!("[{}]", attr("text")),
        "media" => "[image]\n".into(),
        "listItem" => format!("{}- {}\n", "  ".repeat(depth.saturating_sub(1)), kids().trim()),
        "taskItem" => format!("{}{}\n", if attr("state") == "DONE" { "[x] " } else { "[ ] " }, kids().trim()),
        "heading" => format!("\n{} {}\n", "#".repeat(n["attrs"]["level"].as_u64().unwrap_or(2) as usize), kids().trim()),
        "codeBlock" => format!("```\n{}\n```\n", kids()),
        "tableRow" => {
            let cells: Vec<String> = n["content"].as_array().map(|a| {
                a.iter().map(|c| adf(&c["content"], depth).trim().replace('\n', " ")).collect()
            }).unwrap_or_default();
            format!("| {} |\n", cells.join(" | "))
        }
        "paragraph" => kids() + "\n",
        _ => kids(),
    }
}

fn text(v: &Value) -> String {
    let s = if v["type"] == "doc" { adf(v, 0) } else { v.as_str().unwrap_or("").to_string() };
    let mut out = String::new();
    let mut blank = 0;
    for line in s.trim().lines() {
        blank = if line.trim().is_empty() { blank + 1 } else { 0 };
        if blank < 2 {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn cut(s: &str, n: usize) -> String {
    if s.chars().count() > n { s.chars().take(n).collect::<String>() + " …[cut]" } else { s.to_string() }
}
fn day(v: &Value) -> String {
    v.as_str().map(|s| s.chars().take(10).collect()).unwrap_or_default()
}
fn names(v: &Value, k: &str) -> String {
    v.as_array().map(|a| a.iter().filter_map(|x| x[k].as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default()
}

/// Custom fields worth showing: rich text (acceptance criteria…), option values/names, plain text, links.
fn custom_text(v: &Value) -> String {
    match v {
        Value::Null | Value::Bool(_) | Value::Number(_) => String::new(),
        Value::String(s) => if s.starts_with('{') && s.ends_with('}') && s.contains('=') { String::new() } else { s.trim().to_string() },
        Value::Array(a) => a.iter().map(custom_text).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "),
        Value::Object(_) if v["type"] == "doc" => text(v),
        Value::Object(_) => ["value", "name", "displayName"].iter().find_map(|k| v[*k].as_str()).unwrap_or("").to_string(),
    }
}

fn rel(i: &Value) -> String {
    let f = &i["fields"];
    let done = f["status"]["statusCategory"]["key"] == "done";
    format!(
        "{} [{} · {}{}] {}",
        i["key"].as_str().unwrap_or("?"),
        f["issuetype"]["name"].as_str().unwrap_or("?"),
        f["status"]["name"].as_str().unwrap_or("?"),
        if done { " ✓" } else { "" },
        f["summary"].as_str().unwrap_or("")
    )
}
fn rel_desc(i: Option<&Value>) -> String {
    let d = i.map(|i| text(&i["fields"]["description"])).unwrap_or_default();
    if d.is_empty() { String::new() } else { format!("\n    {}", cut(&d, RELATED).replace('\n', "\n    ")) }
}

fn extra_fields(issue: &Value, sp_field: &str) -> Vec<(String, String)> {
    let skip = ["rank", "team", "development", "start date", "sprint", "story point estimate", "flagged"];
    let mut extra: Vec<(String, String)> = issue["fields"]
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(k, _)| k.starts_with("customfield_") && k.as_str() != sp_field && k.as_str() != "customfield_10020")
                .map(|(k, v)| (issue["names"][k].as_str().unwrap_or(k).to_string(), custom_text(v)))
                .filter(|(n, v)| !v.is_empty() && !skip.contains(&n.to_lowercase().as_str()))
                .collect()
        })
        .unwrap_or_default();
    extra.sort();
    extra
}

/// Parent and grandparent (story → epic): children often keep the real requirements there.
async fn ancestors(c: &Conn<'_>, f: &Value) -> Vec<String> {
    let mut out = vec![];
    let mut next = f["parent"]["key"].as_str().map(String::from);
    for level in 0..2 {
        let Some(k) = next.take() else { break };
        let Ok(a) = c.call(reqwest::Method::GET, &format!("/rest/api/3/issue/{k}?fields=*all&expand=names"), None).await else { break };
        let af = &a["fields"];
        let mut parts = vec![
            format!(
                "## {} ticket: {} [{} · {}] {}",
                if level == 0 { "Parent" } else { "Grandparent" },
                a["key"].as_str().unwrap_or(&k),
                af["issuetype"]["name"].as_str().unwrap_or("?"),
                af["status"]["name"].as_str().unwrap_or("?"),
                af["summary"].as_str().unwrap_or("")
            ),
            {
                let d = cut(&text(&af["description"]), PARENT_DESC[level]);
                format!("Description:\n{}", if d.is_empty() { "(empty)".into() } else { d })
            },
        ];
        let extra = extra_fields(&a, c.sp_field);
        if !extra.is_empty() {
            parts.push(format!("Fields:\n{}", extra.iter().map(|(n, v)| format!("{n}: {}", cut(v, 1500))).collect::<Vec<_>>().join("\n")));
        }
        let all = af["comment"]["comments"].as_array().cloned().unwrap_or_default();
        let cs = &all[all.len().saturating_sub(PARENT_COMMENTS)..];
        if !cs.is_empty() {
            parts.push(format!("Latest comments:\n{}", cs.iter().map(|c| format!("- {}, {}: {}", c["author"]["displayName"].as_str().unwrap_or("?"), day(&c["created"]), cut(&text(&c["body"]), 600))).collect::<Vec<_>>().join("\n")));
        }
        out.push(parts.join("\n"));
        next = af["parent"]["key"].as_str().map(String::from);
    }
    out
}

pub async fn collect(c: &Conn<'_>, key: &str) -> Result<(Value, String), String> {
    let issue = c
        .call(reqwest::Method::GET, &format!("/rest/api/3/issue/{key}?fields=*all&expand=names"), None)
        .await?;
    let f = &issue["fields"];
    let ikey = issue["key"].as_str().unwrap_or(key).to_string();
    let links = f["issuelinks"].as_array().cloned().unwrap_or_default();
    let link_keys: Vec<String> = links
        .iter()
        .filter_map(|l| l["outwardIssue"]["key"].as_str().or(l["inwardIssue"]["key"].as_str()).map(String::from))
        .collect();
    let linked_fut = async {
        if link_keys.is_empty() { vec![] } else { c.search(format!("key in ({})", link_keys.join(",")), link_keys.len()).await }
    };
    let ((linked, children), parents) =
        tokio_join(tokio_join(linked_fut, c.search(format!("parent = {ikey} ORDER BY key"), CHILDREN)), ancestors(c, f)).await;
    let by_key: HashMap<String, &Value> = linked.iter().filter_map(|i| i["key"].as_str().map(|k| (k.to_string(), i))).collect();

    let mut out: Vec<String> = vec![format!("# {}: {}", ikey, f["summary"].as_str().unwrap_or(""))];
    let sp = match &f[c.sp_field] { Value::Number(n) => n.to_string(), _ => String::new() };
    let sprint = names(&f["customfield_10020"], "name");
    let parent = if f["parent"].is_object() {
        format!("{} {} ({})", f["parent"]["key"].as_str().unwrap_or(""), f["parent"]["fields"]["summary"].as_str().unwrap_or(""), f["parent"]["fields"]["status"]["name"].as_str().unwrap_or("?"))
    } else { String::new() };
    let labels = f["labels"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    let meta = [
        ("Type", f["issuetype"]["name"].as_str().unwrap_or("").to_string()),
        ("Status", f["status"]["name"].as_str().unwrap_or("").to_string()),
        ("Priority", f["priority"]["name"].as_str().unwrap_or("").to_string()),
        ("Assignee", f["assignee"]["displayName"].as_str().unwrap_or("Unassigned").to_string()),
        ("Reporter", f["reporter"]["displayName"].as_str().unwrap_or("").to_string()),
        ("Story points", sp),
        ("Labels", labels),
        ("Components", names(&f["components"], "name")),
        ("Fix versions", names(&f["fixVersions"], "name")),
        ("Sprint", sprint),
        ("Parent", parent),
        ("Created", day(&f["created"])),
        ("Updated", day(&f["updated"])),
        ("Due", day(&f["duedate"])),
    ];
    out.push(meta.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("\n"));
    let desc = cut(&text(&f["description"]), DESC);
    out.push(format!("## Description\n{}", if desc.is_empty() { "(empty)".into() } else { desc }));

    let extra = extra_fields(&issue, c.sp_field);
    if !extra.is_empty() {
        out.push(format!("## Other fields\n{}", extra.iter().map(|(n, v)| format!("{n}: {}", cut(v, 2000))).collect::<Vec<_>>().join("\n")));
    }
    if let Some(a) = f["attachment"].as_array().filter(|a| !a.is_empty()) {
        out.push(format!("## Attachments\n{}", a.iter().filter_map(|x| x["filename"].as_str()).map(|n| format!("- {n}")).collect::<Vec<_>>().join("\n")));
    }
    out.extend(parents);
    if !links.is_empty() {
        let lines: Vec<String> = links.iter().map(|l| {
            let (o, kind) = if l["outwardIssue"].is_object() { (&l["outwardIssue"], &l["type"]["outward"]) } else { (&l["inwardIssue"], &l["type"]["inward"]) };
            let full = o["key"].as_str().and_then(|k| by_key.get(k).copied());
            format!("- {}: {}{}", kind.as_str().unwrap_or("relates to"), rel(full.unwrap_or(o)), rel_desc(full))
        }).collect();
        out.push(format!("## Linked tickets\n{}", lines.join("\n")));
    }
    if !children.is_empty() {
        out.push(format!("## Child tickets ({})\n{}", children.len(), children.iter().map(|c| format!("- {}{}", rel(c), rel_desc(Some(c)))).collect::<Vec<_>>().join("\n")));
    }
    let all = f["comment"]["comments"].as_array().cloned().unwrap_or_default();
    let comments = &all[all.len().saturating_sub(COMMENTS)..];
    if !comments.is_empty() {
        let total = f["comment"]["total"].as_u64().unwrap_or(all.len() as u64);
        out.push(format!(
            "## Comments (latest {} of {}, oldest first)\n{}",
            comments.len(),
            total,
            comments.iter().map(|c| format!("- {}, {}: {}", c["author"]["displayName"].as_str().unwrap_or("?"), day(&c["created"]), cut(&text(&c["body"]), COMMENT))).collect::<Vec<_>>().join("\n")
        ));
    }
    Ok((issue, cut(&out.join("\n\n"), TOTAL)))
}

/// Two futures at once without pulling in another crate.
async fn tokio_join<A, B>(a: impl std::future::Future<Output = A>, b: impl std::future::Future<Output = B>) -> (A, B) {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    let (mut ra, mut rb) = (None, None);
    std::future::poll_fn(|cx| {
        if ra.is_none() { if let std::task::Poll::Ready(v) = a.as_mut().poll(cx) { ra = Some(v); } }
        if rb.is_none() { if let std::task::Poll::Ready(v) = b.as_mut().poll(cx) { rb = Some(v); } }
        if ra.is_some() && rb.is_some() { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
    }).await;
    (ra.unwrap(), rb.unwrap())
}

/* ---------- claude -p ---------- */

/// GUI apps don't get the login PATH: check the usual install spots, then ask the login shell.
pub fn find_claude(custom: &str, home: &Path) -> Option<String> {
    if !custom.trim().is_empty() {
        let c = custom.trim();
        return Some(c.strip_prefix("~/").map(|r| home.join(r).to_string_lossy().into_owned()).unwrap_or_else(|| c.to_string()));
    }
    for d in [home.join(".local/bin"), home.join(".claude/local"), "/opt/homebrew/bin".into(), "/usr/local/bin".into(), "/usr/bin".into()] {
        let p = d.join("claude");
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(shell).args(["-lc", "command -v claude"]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

fn run_claude(exe: &str, model: &str, system: &str, input: &str, dir: &Path) -> Result<Value, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let bin_dir = Path::new(exe).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let path = format!("{bin_dir}:/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default());
    let mut cmd = Command::new(exe);
    cmd.args(["-p", "--tools", "", "--output-format", "json", "--no-session-persistence", "--system-prompt", system]);
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    // A neutral folder, so no project CLAUDE.md is pulled in.
    let mut child = cmd
        .current_dir(dir)
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start claude: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let env: Value = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(_) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err([err, stdout].into_iter().find(|s| !s.is_empty()).unwrap_or_else(|| format!("claude exited with {}", out.status)));
        }
    };
    if env["is_error"].as_bool().unwrap_or(false) {
        let r = env["result"].as_str().unwrap_or("");
        return Err(if r.is_empty() { format!("claude error ({})", env["subtype"].as_str().unwrap_or("unknown")) } else { r.to_string() });
    }
    Ok(env)
}

/// The model is told to answer with bare JSON; tolerate a code fence or a sentence around it.
pub fn parse_answer(s: &str) -> Value {
    let t = s.trim();
    let body = match (t.find('{'), t.rfind('}')) {
        (Some(a), Some(b)) if b > a => &t[a..=b],
        _ => t,
    };
    let list = |v: &Value| -> Vec<String> {
        v.as_array().map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).filter(|s| !s.is_empty()).take(6).collect()).unwrap_or_default()
    };
    match serde_json::from_str::<Value>(body) {
        Ok(v) => {
            let ready = v["ready"].as_str().filter(|r| ["yes", "partly", "no"].contains(r)).unwrap_or("unknown");
            json!({ "ready": ready, "todo": v["todo"].as_str().unwrap_or(""), "steps": list(&v["steps"]), "gaps": list(&v["gaps"]), "checks": list(&v["checks"]) })
        }
        Err(_) => json!({ "ready": "unknown", "todo": t, "steps": [], "gaps": [], "checks": [] }),
    }
}

/// Short fingerprint of the prompt, so cached briefs are redone when it changes.
fn prompt_id(system: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in system.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("{:x}", h & 0xffff_ffff)
}

pub fn valid_key(key: &str) -> bool {
    let mut parts = key.splitn(2, '-');
    let (p, n) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    p.chars().next().map_or(false, |c| c.is_ascii_uppercase())
        && p.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !n.is_empty()
        && n.chars().all(|c| c.is_ascii_digit())
}

/// Everything answered so far, so rows can show their verdict right after a restart.
pub fn cached(cache_file: &Path) -> Value {
    std::fs::read_to_string(cache_file).ok().and_then(|s| serde_json::from_str(&s).ok()).filter(Value::is_object).unwrap_or(json!({}))
}

/// Ticket key → brief. Reuses the cached one while the ticket, model, language and prompt are unchanged.
pub async fn brief(c: &Conn<'_>, key: &str, o: Options, home: &Path) -> Result<Value, String> {
    let key = key.trim().to_uppercase();
    if !valid_key(&key) {
        return Err("Not a ticket key".into());
    }
    let (issue, input) = collect(c, &key).await?;
    let f = &issue["fields"];
    let ikey = issue["key"].as_str().unwrap_or(&key).to_string();
    let updated = f["updated"].as_str().unwrap_or("").to_string();
    let system = if o.prompt.trim().is_empty() { DEFAULT_PROMPT } else { o.prompt.as_str() }.replace("{{LANGUAGE}}", &o.language);
    let pid = prompt_id(&system);
    let cache = cached(&o.cache_file);
    let hit = &cache[&ikey];
    if !o.force && hit["updated"] == updated.as_str() && hit["model"] == o.model.as_str() && hit["language"] == o.language.as_str() && hit["prompt"] == pid.as_str() {
        let mut v = hit.clone();
        v["cached"] = json!(true);
        return Ok(v);
    }
    let exe = find_claude(&o.claude_path, home).ok_or("Claude Code CLI not found. Install it, or set its path in Settings → Claude path.")?;
    let (model, dir) = (o.model.clone(), o.work_dir.clone());
    let env = tauri::async_runtime::spawn_blocking(move || run_claude(&exe, &model, &system, &input, &dir))
        .await
        .map_err(|e| e.to_string())??;
    let mut res = parse_answer(env["result"].as_str().unwrap_or(""));
    for (k, v) in [
        ("key", json!(ikey)),
        ("summary", f["summary"].clone()),
        ("status", f["status"]["name"].clone()),
        ("updated", json!(updated)),
        ("at", json!(now_iso())),
        ("model", json!(o.model)),
        ("language", json!(o.language)),
        ("prompt", json!(pid)),
        ("cost", env["total_cost_usd"].clone()),
        ("ms", env["duration_ms"].clone()),
    ] {
        res[k] = v;
    }
    // Re-read under a lock right before writing: other briefs may have finished while Claude was working.
    {
        static CACHE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _g = CACHE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut fresh = cached(&o.cache_file);
        fresh[&ikey] = res.clone();
        if let Ok(s) = serde_json::to_string_pretty(&fresh) {
            let _ = std::fs::write(&o.cache_file, s);
        }
    }
    res["cached"] = json!(false);
    Ok(res)
}

/// UTC timestamp without a date crate (civil-from-days).
fn now_iso() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_answers() {
        let v = parse_answer("```json\n{\"ready\":\"partly\",\"todo\":\"Do X\",\"steps\":[\"a\"],\"gaps\":[\"b\"],\"checks\":[\"c\"]}\n```");
        assert_eq!(v["ready"], "partly");
        assert_eq!(v["gaps"][0], "b");
        assert_eq!(v["checks"][0], "c");
        assert_eq!(parse_answer("just text")["ready"], "unknown");
    }
    #[test]
    fn adf_to_text() {
        let doc = json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"Hello"}]},
            {"type":"rule"},{"type":"unknownLeaf","attrs":{}},
            {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]}]}]}
        ]});
        assert_eq!(text(&doc), "Hello\n- one");
    }
    #[test]
    fn keys() {
        assert!(valid_key("ABC-123"));
        assert!(!valid_key("abc-1"));
        assert!(!valid_key("ABC-"));
        assert!(!valid_key("ABC-1) OR 1=1"));
    }
    #[test]
    fn iso_date() {
        assert_eq!(now_iso().len(), 20);
    }
}

/// Live check against Jira + claude: `cargo test --lib live_brief -- --ignored --nocapture` (key in BRIEF_KEY).
#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn live_brief() {
        let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
        let env = std::fs::read_to_string(home.join(".release-script.env")).unwrap();
        let get = |k: &str| env.lines().find_map(|l| l.trim().strip_prefix(&format!("{k}=")).map(|v| v.trim_matches(|c| c == '"' || c == '\'').to_string())).unwrap();
        use base64::Engine;
        let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", get("ATLASSIAN_EMAIL"), get("ATLASSIAN_API_TOKEN"))));
        let client = reqwest::Client::new();
        let conn = super::Conn { client: &client, site: "https://your-site.atlassian.net", auth: &auth, sp_field: "customfield_10XXX" };
        let tmp = std::env::temp_dir().join("jpb-brief-test");
        let o = super::Options { prompt: String::new(), model: "sonnet".into(), language: "English".into(), claude_path: String::new(), cache_file: tmp.join("cache.json"), work_dir: tmp.clone(), force: true };
        let key = std::env::var("BRIEF_KEY").unwrap_or_else(|_| "ABC-123".into());
        let rt = tauri::async_runtime::block_on(super::brief(&conn, &key, o, &home));
        println!("{}", serde_json::to_string_pretty(&rt.unwrap()).unwrap());
    }
}
