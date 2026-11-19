//! Jira People Board — Tauri backend.
//! Reads ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN from the credentials file (Settings, else $JIRA_ENV_FILE,
//! else ~/.release-script.env),
//! talks to Jira REST, keeps the people list in the app data folder, and serves avatars
//! through the `avatar://` protocol so the token never reaches the web page.

mod brief;

use base64::Engine;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf, sync::{Arc, Mutex, RwLock}};
use tauri::{
    http::Response,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};

const DEFAULT_SITE: &str = "https://your-site.atlassian.net";
const DEFAULT_SP_FIELD: &str = "customfield_10XXX"; // story points
const DEFAULT_TEAM_FIELD: &str = "customfield_10YYY"; // Team field

struct Jira {
    client: reqwest::Client,
    site: String,
    auth: String,
    sp_field: String,
    team_field: String,
    team_clause: String,
    env_path: PathBuf,
    /// Zoom incoming webhook (ZOOM_WEBHOOK_URL, ZOOM_WEBHOOK_TOKEN) for the daily report, if set.
    zoom: Option<(String, String)>,
}

struct AppState {
    /// Rebuilt when Settings are saved, so a new credentials file or field id applies without a restart.
    jira: RwLock<Result<Arc<Jira>, String>>,
    avatars: Mutex<HashMap<String, (String, Vec<u8>)>>,
    home: PathBuf,
}

/// Settings the user can change in the app (settings.json in the app data folder).
/// Empty strings / missing keys fall back to environment variables, then the credentials file, then defaults.
fn settings_read(app: &tauri::AppHandle) -> Value {
    data_file(app, "settings.json")
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .filter(|v: &Value| v.is_object())
        .unwrap_or_else(|| json!({}))
}
fn setting(s: &Value, k: &str) -> Option<String> {
    s[k].as_str().map(str::trim).filter(|v| !v.is_empty()).map(String::from)
}
/// "customfield_12345" -> "cf[12345]" for JQL; anything else is used as written.
fn jql_clause(field: &str) -> String {
    match field.strip_prefix("customfield_") {
        Some(n) if n.chars().all(|c| c.is_ascii_digit()) => format!("cf[{n}]"),
        _ => field.to_string(),
    }
}
fn expand_home(p: &str, home: &PathBuf) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(p),
    }
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

fn default_env_path(home: &PathBuf) -> PathBuf {
    std::env::var("JIRA_ENV_FILE").map(PathBuf::from).unwrap_or_else(|_| home.join(".release-script.env"))
}

fn load_jira(home: &PathBuf, settings: &Value) -> Result<Jira, String> {
    let env_path = setting(settings, "envFile").map(|p| expand_home(&p, home)).unwrap_or_else(|| default_env_path(home));
    let env = read_env(&env_path)?;
    let missing = |k: &str| format!("CONFIG:{k} is missing in {}", env_path.display());
    let email = env.get("ATLASSIAN_EMAIL").ok_or_else(|| missing("ATLASSIAN_EMAIL"))?;
    let token = env.get("ATLASSIAN_API_TOKEN").ok_or_else(|| missing("ATLASSIAN_API_TOKEN"))?;
    let pick = |sk: &str, k: &str, d: &str| {
        setting(settings, sk)
            .or_else(|| std::env::var(k).ok())
            .or_else(|| env.get(k).cloned())
            .unwrap_or_else(|| d.to_string())
    };
    let team_field = pick("teamField", "JIRA_TEAM_FIELD", DEFAULT_TEAM_FIELD);
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
        site: pick("site", "JIRA_SITE", DEFAULT_SITE).trim_end_matches('/').to_string(),
        auth,
        sp_field: pick("spField", "JIRA_SP_FIELD", DEFAULT_SP_FIELD),
        team_clause: jql_clause(&team_field),
        team_field,
        env_path: env_path.clone(),
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

fn jira(s: &AppState) -> Result<Arc<Jira>, String> {
    s.jira.read().unwrap().clone()
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

/// Settings as saved, the values actually in use, and whether Jira / Zoom are set up.
fn config_view(app: &tauri::AppHandle, state: &AppState) -> Value {
    let saved = settings_read(app);
    let home = &state.home;
    match jira(state) {
        Ok(j) => json!({
            "settings": saved,
            "effective": { "envFile": j.env_path.display().to_string(), "site": j.site, "spField": j.sp_field,
                           "teamField": j.team_field, "teamClause": j.team_clause },
            "defaults": { "envFile": default_env_path(home).display().to_string(), "site": DEFAULT_SITE,
                          "spField": DEFAULT_SP_FIELD, "teamField": DEFAULT_TEAM_FIELD,
                          "briefModel": brief::DEFAULT_MODEL, "briefLanguage": brief::DEFAULT_LANGUAGE,
                          "claudePath": brief::find_claude("", home).unwrap_or_default(),
                          "briefPrompt": brief::DEFAULT_PROMPT },
            "error": Value::Null, "zoom": j.zoom.is_some(),
        }),
        Err(e) => json!({
            "settings": saved,
            "effective": { "teamClause": jql_clause(&setting(&saved, "teamField").unwrap_or_else(|| DEFAULT_TEAM_FIELD.into())) },
            "defaults": { "envFile": default_env_path(home).display().to_string(), "site": DEFAULT_SITE,
                          "spField": DEFAULT_SP_FIELD, "teamField": DEFAULT_TEAM_FIELD,
                          "briefModel": brief::DEFAULT_MODEL, "briefLanguage": brief::DEFAULT_LANGUAGE,
                          "claudePath": brief::find_claude("", home).unwrap_or_default(),
                          "briefPrompt": brief::DEFAULT_PROMPT },
            "error": e.trim_start_matches("CONFIG:"), "zoom": false,
        }),
    }
}

#[tauri::command]
fn config_get(app: tauri::AppHandle, state: State<'_, AppState>) -> Value {
    config_view(&app, &state)
}

/// Save settings and reconnect with them.
#[tauri::command]
fn config_save(app: tauri::AppHandle, state: State<'_, AppState>, settings: Value) -> Result<Value, String> {
    if !settings.is_object() {
        return Err("Expected an object".into());
    }
    write_json(&data_file(&app, "settings.json")?, &settings)?;
    *state.jira.write().unwrap() = load_jira(&state.home, &settings).map(Arc::new);
    state.avatars.lock().unwrap().clear();
    let view = config_view(&app, &state);
    // Tell the board window to pick up the new settings.
    let _ = app.emit("config-changed", &view);
    Ok(view)
}

/// Check the connection: who the token belongs to, and the names of the configured custom fields.
#[tauri::command]
async fn config_check(state: State<'_, AppState>) -> Result<Value, String> {
    let j = jira(&state)?;
    let me = j.req(reqwest::Method::GET, "/rest/api/3/myself", None).await?;
    let fields = j.req(reqwest::Method::GET, "/rest/api/3/field", None).await.unwrap_or(json!([]));
    let name_of = |id: &str| {
        fields.as_array().and_then(|a| a.iter().find(|f| f["id"] == id)).and_then(|f| f["name"].as_str()).map(String::from)
    };
    Ok(json!({ "user": me["displayName"], "email": me["emailAddress"], "spName": name_of(&j.sp_field), "teamName": name_of(&j.team_field) }))
}

/// Open (or bring forward) the Settings window: App menu → Settings… (⌘,) or the gear button.
fn show_settings(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let mut b = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html?view=settings".into()))
        .title("Settings")
        .inner_size(600.0, 780.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .disable_drag_drop_handler();
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(size), Ok(scale)) = (main.outer_position(), main.outer_size(), main.scale_factor()) {
            let (x, y) = (pos.x as f64 / scale, pos.y as f64 / scale);
            let w = size.width as f64 / scale;
            b = b.position(x + (w - 600.0) / 2.0, y + 80.0);
        }
    }
    let _ = b.build();
}

const CREDENTIALS_TEMPLATE: &str = "# Jira People Board — credentials
# Keep this file private. Values go right after the = sign, no quotes needed.

# Jira account email and API token
# Create a token at https://id.atlassian.com/manage-profile/security/api-tokens
ATLASSIAN_EMAIL=
ATLASSIAN_API_TOKEN=

# Optional: Zoom incoming webhook for sending Daily notes to a channel
# (in Zoom: Team Chat → Apps → Incoming Webhook → /inc connect <name>)
ZOOM_WEBHOOK_URL=
ZOOM_WEBHOOK_TOKEN=
";

/// Write an empty credentials template at `path` (never over a file that has content),
/// readable only by the user, then open it in the default text editor.
#[tauri::command]
fn credentials_template(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false) {
        return Err(format!("{path} already has content — not overwriting it"));
    }
    fs::write(&p, CREDENTIALS_TEMPLATE).map_err(|e| format!("Couldn't write {path}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg("-t").arg(&p).spawn().map_err(|e| format!("Created, but couldn't open it: {e}"))?;
    Ok(())
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    show_settings(&app);
}

/// macOS menu bar: app menu with Settings… ⌘, plus the standard Edit and Window menus
/// (Edit keeps ⌘C / ⌘V / ⌘Z working in text fields once a custom menu is set).
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let app_menu = Submenu::with_items(
        app,
        "Jira People Board",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

/// Post the daily report to the Zoom channel: rich ("full") format first, plain text if Zoom rejects it.
/// Returns the format that was accepted.
#[tauri::command]
async fn zoom_send(state: State<'_, AppState>, full: Value, text: String) -> Result<String, String> {
    let j = jira(&state)?;
    let (url, token) = j.zoom.as_ref().ok_or(
        "CONFIG:ZOOM_WEBHOOK_URL / ZOOM_WEBHOOK_TOKEN are missing in the credentials file",
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

/// Ticket brief via `claude -p` (see brief.rs). Settings: briefModel, briefLanguage, claudePath.
#[tauri::command]
async fn ticket_brief(app: tauri::AppHandle, state: State<'_, AppState>, key: String, force: Option<bool>) -> Result<Value, String> {
    let j = jira(&state)?;
    let s = settings_read(&app);
    let opts = brief::Options {
        model: setting(&s, "briefModel").unwrap_or_else(|| brief::DEFAULT_MODEL.into()),
        language: setting(&s, "briefLanguage").unwrap_or_else(|| brief::DEFAULT_LANGUAGE.into()),
        claude_path: setting(&s, "claudePath").unwrap_or_default(),
        prompt: setting(&s, "briefPrompt").unwrap_or_default(),
        cache_file: data_file(&app, "briefs.json")?,
        work_dir: app.path().app_data_dir().map_err(|e| e.to_string())?.join("brief-work"),
        force: force.unwrap_or(false),
    };
    let conn = brief::Conn { client: &j.client, site: &j.site, auth: &j.auth, sp_field: &j.sp_field };
    brief::brief(&conn, &key, opts, &state.home).await
}

#[tauri::command]
fn brief_cache(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(brief::cached(&data_file(&app, "briefs.json")?))
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
            assigned_since(&j, &ids, a).await.unwrap_or_default()
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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let home = app.path().home_dir().unwrap_or_default();
            let settings = settings_read(app.handle());
            let jira = load_jira(&home, &settings).map(Arc::new);
            app.manage(AppState { jira: RwLock::new(jira), avatars: Mutex::new(HashMap::new()), home });
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, e| {
                if e.id() == "settings" {
                    show_settings(app);
                }
            });
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
            ticket_brief,
            brief_cache,
            config_get,
            config_save,
            config_check,
            open_settings,
            credentials_template,
            users_search,
            projects_search,
            teams_search,
            issues_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jira People Board");
}

#[cfg(test)]
mod template_tests {
    #[test]
    fn writes_and_refuses_overwrite() {
        let p = std::env::temp_dir().join("jpb-template-test.env");
        let _ = std::fs::remove_file(&p);
        std::fs::write(&p, "").unwrap(); // empty file is fine to fill
        // Skip the `open -t` side effect: write the same way the command does.
        assert!(std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false) == false);
        std::fs::write(&p, super::CREDENTIALS_TEMPLATE).unwrap();
        assert!(super::credentials_template(p.display().to_string()).unwrap_err().contains("not overwriting"));
        let t = std::fs::read_to_string(&p).unwrap();
        for k in ["ATLASSIAN_EMAIL=", "ATLASSIAN_API_TOKEN=", "ZOOM_WEBHOOK_URL=", "ZOOM_WEBHOOK_TOKEN="] { assert!(t.contains(k)); }
        let _ = std::fs::remove_file(&p);
    }
}
