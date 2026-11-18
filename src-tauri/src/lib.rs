//! Jira People Board — Tauri backend.
//! Reads ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN from ~/.release-script.env (or $JIRA_ENV_FILE),
//! talks to Jira REST, keeps the people list in the app data folder, and serves avatars
//! through the `avatar://` protocol so the token never reaches the web page.

use base64::Engine;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};
use tauri::{http::Response, Manager, State};

const DEFAULT_SITE: &str = "https://your-site.atlassian.net";
const DEFAULT_SP_FIELD: &str = "customfield_10XXX"; // story points
const DEFAULT_TEAM_CLAUSE: &str = "cf[10YYY]"; // Team field (customfield_10YYY)

struct Jira {
    client: reqwest::Client,
    site: String,
    auth: String,
    sp_field: String,
    team_clause: String,
    /// Zoom incoming webhook (ZOOM_WEBHOOK_URL, ZOOM_WEBHOOK_TOKEN) for the daily report, if set.
    zoom: Option<(String, String)>,
}

struct AppState {
    jira: Result<Jira, String>,
    avatars: Mutex<HashMap<String, (String, Vec<u8>)>>,
}

fn read_env(path: &PathBuf) -> Result<HashMap<String, String>, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("CONFIG:Can't read {}: {e}", path.display()))?;
    let mut out = HashMap::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let l = l.strip_prefix("export ").unwrap_or(l);
        if let Some((k, v)) = l.split_once('=') {
            let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
            out.insert(k.trim().to_string(), v.to_string());
        }
    }
    Ok(out)
}

fn load_jira(home: PathBuf) -> Result<Jira, String> {
    let env_path = std::env::var("JIRA_ENV_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".release-script.env"));
    let env = read_env(&env_path)?;
    let missing = |k: &str| format!("CONFIG:{k} is missing in {}", env_path.display());
    let email = env.get("ATLASSIAN_EMAIL").ok_or_else(|| missing("ATLASSIAN_EMAIL"))?;
    let token = env.get("ATLASSIAN_API_TOKEN").ok_or_else(|| missing("ATLASSIAN_API_TOKEN"))?;
    let pick = |k: &str, d: &str| {
        std::env::var(k).ok().or_else(|| env.get(k).cloned()).unwrap_or_else(|| d.to_string())
    };
    let auth = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{email}:{token}"))
    );
    let client = reqwest::Client::builder()
        .user_agent("jira-people-board")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(Jira {
        client,
        site: pick("JIRA_SITE", DEFAULT_SITE).trim_end_matches('/').to_string(),
        auth,
        sp_field: pick("JIRA_SP_FIELD", DEFAULT_SP_FIELD),
        team_clause: pick("JIRA_TEAM_CLAUSE", DEFAULT_TEAM_CLAUSE),
        zoom: match (env.get("ZOOM_WEBHOOK_URL"), env.get("ZOOM_WEBHOOK_TOKEN")) {
            (Some(u), Some(t)) if !u.is_empty() && !t.is_empty() => Some((u.clone(), t.clone())),
            _ => None,
        },
    })
}

impl Jira {
    async fn req(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        let mut rb = self
            .client
            .request(method, format!("{}{}", self.site, path))
            .header("Authorization", &self.auth)
            .header("Accept", "application/json");
        if let Some(b) = body {
            rb = rb.json(&b);
        }
        let r = rb.send().await.map_err(|e| format!("Couldn't reach Jira: {e}"))?;
        let status = r.status();
        let text = r.text().await.map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&text)
            .unwrap_or_else(|_| json!({ "message": text.chars().take(300).collect::<String>() }));
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("AUTH:Jira rejected the API token".into());
        }
        if !status.is_success() {
            let msg = v["errorMessages"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("; "))
                .filter(|s| !s.is_empty())
                .or_else(|| v["message"].as_str().map(String::from))
                .unwrap_or_else(|| format!("Jira returned {status}"));
            return Err(msg);
        }
        Ok(v)
    }
}

fn jira<'a>(s: &'a AppState) -> Result<&'a Jira, String> {
    s.jira.as_ref().map_err(|e| e.clone())
}
fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}
fn data_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}
fn people_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    data_file(app, "people.json")
}
fn write_json(path: &PathBuf, v: &Value) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/* ---------- commands ---------- */

#[tauri::command]
fn people_load(app: tauri::AppHandle) -> Result<Value, String> {
    let path = people_file(&app)?;
    match fs::read_to_string(&path) {
        Ok(t) => Ok(serde_json::from_str(&t).unwrap_or_else(|_| json!([]))),
        Err(_) => Ok(json!([])),
    }
}

#[tauri::command]
fn people_save(app: tauri::AppHandle, list: Value) -> Result<(), String> {
    if !list.is_array() {
        return Err("Expected a list".into());
    }
    let path = people_file(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Daily notes: {"YYYY-MM-DD": {rowId: {done, doing, at}}}.
#[tauri::command]
fn notes_load(app: tauri::AppHandle) -> Result<Value, String> {
    let path = data_file(&app, "notes.json")?;
    Ok(fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({})))
}

/// Upsert one person's entry for one day; an entry with both fields empty is removed.
#[tauri::command]
fn notes_put(app: tauri::AppHandle, day: String, id: String, done: String, doing: String) -> Result<(), String> {
    let path = data_file(&app, "notes.json")?;
    let mut all: Value = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
    if !all.is_object() {
        all = json!({});
    }
    let map = all.as_object_mut().unwrap();
    let dayv = map.entry(day.clone()).or_insert_with(|| json!({}));
    if !dayv.is_object() {
        *dayv = json!({});
    }
    let d = dayv.as_object_mut().unwrap();
    if done.trim().is_empty() && doing.trim().is_empty() {
        d.remove(&id);
    } else {
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_millis() as u64).unwrap_or(0);
        d.insert(id, json!({ "done": done, "doing": doing, "at": at }));
    }
    if d.is_empty() {
        map.remove(&day);
    }
    write_json(&path, &all)
}

/// Post the daily report to the Zoom channel: rich ("full") format first, plain text if Zoom rejects it.
/// Returns the format that was accepted.
#[tauri::command]
async fn zoom_send(state: State<'_, AppState>, full: Value, text: String) -> Result<String, String> {
    let j = jira(&state)?;
    let (url, token) = j.zoom.as_ref().ok_or(
        "CONFIG:ZOOM_WEBHOOK_URL / ZOOM_WEBHOOK_TOKEN are missing in ~/.release-script.env",
    )?;
    if !url.starts_with("https://integrations.zoom.us/") {
        return Err("CONFIG:ZOOM_WEBHOOK_URL must be an https://integrations.zoom.us/ webhook".into());
    }
    let post = |format: &str, body: String| {
        j.client
            .post(format!("{url}?format={format}"))
            .header("Authorization", token)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
    };
    let r = post("full", full.to_string()).await.map_err(|e| e.to_string())?;
    if r.status().is_success() {
        return Ok("full".into());
    }
    let r = post("message", text).await.map_err(|e| e.to_string())?;
    if r.status().is_success() {
        return Ok("message".into());
    }
    let status = r.status();
    let body = r.text().await.unwrap_or_default();
    Err(format!("Zoom returned {status}: {}", body.chars().take(200).collect::<String>()))
}

#[tauri::command]
async fn users_search(state: State<'_, AppState>, q: String) -> Result<Value, String> {
    let j = jira(&state)?;
    let v = j
        .req(reqwest::Method::GET, &format!("/rest/api/3/user/search?maxResults=20&query={}", enc(&q)), None)
        .await?;
    let out: Vec<Value> = v
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|u| u["accountType"] == "atlassian")
        .map(|u| {
            json!({
                "accountId": u["accountId"],
                "displayName": u["displayName"],
                "email": u["emailAddress"].as_str().unwrap_or(""),
                "avatarUrl": u["avatarUrls"]["48x48"].as_str().or(u["avatarUrls"]["32x32"].as_str()).unwrap_or(""),
                "active": u["active"],
            })
        })
        .collect();
    Ok(Value::Array(out))
}

/// Teams (customfield_10YYY) matching `q`, via JQL value suggestions.
#[tauri::command]
async fn teams_search(state: State<'_, AppState>, q: String) -> Result<Value, String> {
    let j = jira(&state)?;
    let v = j
        .req(
            reqwest::Method::GET,
            &format!(
                "/rest/api/3/jql/autocompletedata/suggestions?fieldName={}&fieldValue={}",
                enc(&j.team_clause),
                enc(&q)
            ),
            None,
        )
        .await?;
    let strip = |s: &str| {
        let mut out = String::new();
        let mut in_tag = false;
        for c in s.chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => out.push(c),
                _ => {}
            }
        }
        out
    };
    let out: Vec<Value> = v["results"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|t| json!({ "teamId": t["value"], "displayName": strip(t["displayName"].as_str().unwrap_or("")) }))
        .collect();
    Ok(Value::Array(out))
}

#[tauri::command]
async fn projects_search(state: State<'_, AppState>, q: String) -> Result<Value, String> {
    let j = jira(&state)?;
    let v = j
        .req(
            reqwest::Method::GET,
            &format!("/rest/api/3/project/search?maxResults=50&action=browse&orderBy=name&query={}", enc(&q)),
            None,
        )
        .await?;
    let out: Vec<Value> = v["values"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|p| json!({ "key": p["key"], "name": p["name"] }))
        .collect();
    Ok(Value::Array(out))
}

#[tauri::command]
async fn issues_search(
    state: State<'_, AppState>,
    jql: String,
    max_results: Option<u32>,
    assignee: Option<String>,
) -> Result<Value, String> {
    let j = jira(&state)?;
    let body = json!({
        "jql": jql,
        "maxResults": max_results.unwrap_or(100),
        "fields": ["summary", "status", "issuetype", "priority", "project", "created", "updated", "assignee", j.sp_field],
    });
    let r = j.req(reqwest::Method::POST, "/rest/api/3/search/jql", Some(body)).await?;
    let since = match &assignee {
        Some(a) => {
            let ids: Vec<String> = r["issues"]
                .as_array()
                .map(|v| v.iter().filter_map(|n| n["id"].as_str().map(String::from)).collect())
                .unwrap_or_default();
            assigned_since(j, &ids, a).await.unwrap_or_default()
        }
        None => HashMap::new(),
    };
    let issues: Vec<Value> = r["issues"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|n| {
            let f = &n["fields"];
            let key = n["key"].as_str().unwrap_or("").to_string();
            let created = f["created"].as_str().unwrap_or("").to_string();
            let hist = n["id"].as_str().and_then(|id| since.get(id)).copied();
            // No assignee change in history means the issue was assigned when it was created.
            let assigned_at = match (hist, &assignee) {
                (Some(ms), _) => json!(ms),
                (None, Some(_)) => json!(created),
                _ => Value::Null,
            };
            json!({
                "key": key,
                "summary": f["summary"].as_str().unwrap_or(""),
                "status": f["status"]["name"].as_str().unwrap_or(""),
                "cat": f["status"]["statusCategory"]["key"].as_str().unwrap_or("new"),
                "type": f["issuetype"]["name"].as_str().unwrap_or(""),
                "icon": f["issuetype"]["iconUrl"].as_str().unwrap_or(""),
                "sp": f[&j.sp_field].as_f64(),
                "created": created,
                "updated": f["updated"].as_str().unwrap_or(""),
                "assignedAt": assigned_at,
                "assignedFromHistory": hist.is_some(),
                "assignee": f["assignee"]["displayName"].as_str().unwrap_or(""),
                "priority": f["priority"]["name"].as_str().unwrap_or(""),
                "priorityIcon": f["priority"]["iconUrl"].as_str().unwrap_or(""),
                "url": format!("{}/browse/{}", j.site, key),
            })
        })
        .collect();
    let more = !r["isLast"].as_bool().unwrap_or(true) && r["nextPageToken"].is_string();
    Ok(json!({ "issues": issues, "more": more, "url": format!("{}/issues/?jql={}", j.site, enc(&jql)) }))
}

/// When each issue was last assigned to `account_id`, from the bulk changelog (epoch ms by issue id).
async fn assigned_since(j: &Jira, ids: &[String], account_id: &str) -> Result<HashMap<String, i64>, String> {
    let mut out: HashMap<String, i64> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let mut token: Option<String> = None;
    loop {
        let mut body = json!({ "issueIdsOrKeys": ids, "fieldIds": ["assignee"], "maxResults": 1000 });
        if let Some(t) = &token {
            body["nextPageToken"] = json!(t);
        }
        let r = j.req(reqwest::Method::POST, "/rest/api/3/changelog/bulkfetch", Some(body)).await?;
        for il in r["issueChangeLogs"].as_array().cloned().unwrap_or_default() {
            let id = match il["issueId"].as_str() { Some(s) => s.to_string(), None => continue };
            for h in il["changeHistories"].as_array().cloned().unwrap_or_default() {
                let t = h["created"].as_i64().unwrap_or(0);
                let to_me = h["items"].as_array().map_or(false, |items| {
                    items.iter().any(|i| {
                        (i["fieldId"] == "assignee" || i["field"] == "assignee") && i["to"].as_str() == Some(account_id)
                    })
                });
                if to_me && out.get(&id).map_or(true, |&prev| t > prev) {
                    out.insert(id.clone(), t);
                }
            }
        }
        token = r["nextPageToken"].as_str().map(String::from);
        if token.is_none() {
            break;
        }
    }
    Ok(out)
}

/* ---------- avatar:// protocol (Atlassian / Gravatar images, fetched with auth when needed) ---------- */

async fn fetch_avatar(state: &AppState, src: &str) -> Result<(String, Vec<u8>), String> {
    if let Some(hit) = state.avatars.lock().unwrap().get(src) {
        return Ok(hit.clone());
    }
    let url = tauri::Url::parse(src).map_err(|e| e.to_string())?;
    let host = url.host_str().unwrap_or("");
    let allowed = url.scheme() == "https"
        && (host.ends_with(".atlassian.net")
            || host.ends_with(".atl-paas.net")
            || host == "secure.gravatar.com"
            || host == "api.atlassian.com");
    if !allowed {
        return Err("host not allowed".into());
    }
    let j = jira(state)?;
    let mut rb = j.client.get(url.clone());
    if host.ends_with(".atlassian.net") || host == "api.atlassian.com" {
        rb = rb.header("Authorization", &j.auth);
    }
    let r = rb.send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{}", r.status()));
    }
    let ct = r
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = r.bytes().await.map_err(|e| e.to_string())?.to_vec();
    state.avatars.lock().unwrap().insert(src.to_string(), (ct.clone(), bytes.clone()));
    Ok((ct, bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let home = app.path().home_dir().unwrap_or_default();
            app.manage(AppState { jira: load_jira(home), avatars: Mutex::new(HashMap::new()) });
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("avatar", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().trim_start_matches('/').to_string();
            tauri::async_runtime::spawn(async move {
                let src = percent_decode_str(&path).decode_utf8_lossy().to_string();
                let state = app.state::<AppState>();
                let resp = match fetch_avatar(&state, &src).await {
                    Ok((ct, bytes)) => Response::builder()
                        .header("Content-Type", ct)
                        .header("Cache-Control", "max-age=21600")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes),
                    Err(_) => Response::builder().status(404).body(Vec::new()),
                };
                responder.respond(resp.unwrap_or_else(|_| Response::new(Vec::new())));
            });
        })
        .invoke_handler(tauri::generate_handler![
            people_load,
            people_save,
            notes_load,
            notes_put,
            zoom_send,
            users_search,
            projects_search,
            teams_search,
            issues_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jira People Board");
}
