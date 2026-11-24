//! Settings (settings.json in the app data folder) and the credentials file they point to.
//! Precedence for every value: Settings > environment variable > credentials file > built-in default.

use crate::{
    brief,
    error::{AppError, Result},
    jira::Jira,
    storage, AppState,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::{Emitter, State};

pub const DEFAULT_SITE: &str = "https://your-site.atlassian.net";
pub const DEFAULT_SP_FIELD: &str = "customfield_10XXX"; // story points
pub const DEFAULT_TEAM_FIELD: &str = "customfield_10YYY"; // Team

/// Everything the credentials file and Settings give us.
pub struct Connection {
    pub jira: Jira,
    /// Zoom incoming webhook (ZOOM_WEBHOOK_URL, ZOOM_WEBHOOK_TOKEN) for the daily report, if set.
    pub zoom: Option<(String, String)>,
    pub env_path: PathBuf,
}

pub fn settings_read(app: &tauri::AppHandle) -> Value {
    storage::data_file(app, "settings.json")
        .map(|p| storage::read_json(&p, json!({})))
        .unwrap_or_else(|_| json!({}))
}

/// A non-empty, trimmed setting.
pub fn setting(s: &Value, k: &str) -> Option<String> {
    s[k].as_str().map(str::trim).filter(|v| !v.is_empty()).map(String::from)
}

/// "customfield_12345" -> "cf[12345]" for JQL; anything else is used as written.
pub fn jql_clause(field: &str) -> String {
    match field.strip_prefix("customfield_") {
        Some(n) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => format!("cf[{n}]"),
        _ => field.to_string(),
    }
}

pub fn expand_home(p: &str, home: &Path) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(p),
    }
}

/// KEY=VALUE lines; `export ` and surrounding quotes are allowed, `#` starts a comment line.
pub fn parse_env(text: &str) -> HashMap<String, String> {
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
    out
}

pub fn default_env_path(home: &Path) -> PathBuf {
    std::env::var("JIRA_ENV_FILE").map(PathBuf::from).unwrap_or_else(|_| home.join(".release-script.env"))
}

/// The API token goes to this address, so only an https Atlassian Cloud site is accepted.
pub fn check_site(site: &str) -> Result<String> {
    let s = site.trim().trim_end_matches('/');
    let bad = || AppError::Config(format!("Jira site must look like https://your-site.atlassian.net, not \"{s}\""));
    let url = tauri::Url::parse(s).map_err(|_| bad())?;
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let atlassian = host.ends_with(".atlassian.net") || host.ends_with(".jira.com");
    if url.scheme() != "https" || !atlassian || url.port().is_some() || url.path() != "/" || url.query().is_some() {
        return Err(bad());
    }
    Ok(format!("https://{host}"))
}

pub fn load(home: &Path, settings: &Value) -> Result<Connection> {
    let env_path = setting(settings, "envFile").map(|p| expand_home(&p, home)).unwrap_or_else(|| default_env_path(home));
    let text = fs::read_to_string(&env_path)
        .map_err(|e| AppError::Config(format!("Can't read {}: {e}", env_path.display())))?;
    let env = parse_env(&text);
    let need = |k: &str| {
        env.get(k)
            .filter(|v| !v.is_empty())
            .cloned()
            .ok_or_else(|| AppError::Config(format!("{k} is missing in {}", env_path.display())))
    };
    let (email, token) = (need("ATLASSIAN_EMAIL")?, need("ATLASSIAN_API_TOKEN")?);
    let pick = |sk: &str, k: &str, d: &str| {
        setting(settings, sk)
            .or_else(|| std::env::var(k).ok())
            .or_else(|| env.get(k).cloned())
            .unwrap_or_else(|| d.to_string())
    };
    let site = check_site(&pick("site", "JIRA_SITE", DEFAULT_SITE))?;
    let jira = Jira::new(
        site,
        &email,
        &token,
        pick("spField", "JIRA_SP_FIELD", DEFAULT_SP_FIELD),
        pick("teamField", "JIRA_TEAM_FIELD", DEFAULT_TEAM_FIELD),
    )?;
    let zoom = match (env.get("ZOOM_WEBHOOK_URL"), env.get("ZOOM_WEBHOOK_TOKEN")) {
        (Some(u), Some(t)) if !u.is_empty() && !t.is_empty() => Some((u.clone(), t.clone())),
        _ => None,
    };
    Ok(Connection { jira, zoom, env_path })
}

/// Settings as saved, the values actually in use, the defaults, and whether Jira / Zoom are set up.
fn view(app: &tauri::AppHandle, state: &AppState) -> Value {
    let saved = settings_read(app);
    let home = &state.home;
    let defaults = json!({
        "envFile": default_env_path(home).display().to_string(), "site": DEFAULT_SITE,
        "spField": DEFAULT_SP_FIELD, "teamField": DEFAULT_TEAM_FIELD,
        "briefModel": brief::DEFAULT_MODEL, "briefLanguage": brief::DEFAULT_LANGUAGE,
        "claudePath": brief::claude::find("", home).unwrap_or_default(),
        "briefPrompt": brief::DEFAULT_PROMPT,
    });
    match state.conn() {
        Ok(c) => json!({
            "settings": saved,
            "effective": { "envFile": c.env_path.display().to_string(), "site": c.jira.site, "spField": c.jira.sp_field,
                           "teamField": c.jira.team_field, "teamClause": c.jira.team_clause },
            "defaults": defaults, "error": Value::Null, "zoom": c.zoom.is_some(),
        }),
        Err(e) => json!({
            "settings": saved,
            "effective": { "teamClause": jql_clause(&setting(&saved, "teamField").unwrap_or_else(|| DEFAULT_TEAM_FIELD.into())) },
            "defaults": defaults, "error": e.message(), "zoom": false,
        }),
    }
}

// Async so the first call (which may ask the login shell where claude is) stays off the main thread.
#[tauri::command]
pub async fn config_get(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value> {
    Ok(view(&app, &state))
}

/// Save settings and reconnect with them.
#[tauri::command]
pub async fn config_save(app: tauri::AppHandle, state: State<'_, AppState>, settings: Value) -> Result<Value> {
    if !settings.is_object() {
        return Err(AppError::Other("Expected an object".into()));
    }
    // Refuse a bad site up front: it would get the API token.
    if let Some(site) = setting(&settings, "site") {
        check_site(&site)?;
    }
    {
        // One save at a time: two writers would share settings.json.tmp, and the last write must match the connection.
        let _g = storage::WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        storage::write_json(&storage::data_file(&app, "settings.json")?, &settings)?;
        state.reconnect(&settings);
    }
    let v = view(&app, &state);
    // Tell the board window to pick up the new settings.
    let _ = app.emit("config-changed", &v);
    Ok(v)
}

/// Check the connection: who the token belongs to, and the names of the configured custom fields.
#[tauri::command]
pub async fn config_check(state: State<'_, AppState>) -> Result<Value> {
    let c = state.conn()?;
    let j = &c.jira;
    let me = j.get("/rest/api/3/myself").await?;
    let fields = j.get("/rest/api/3/field").await.unwrap_or(json!([]));
    let name_of = |id: &str| {
        fields
            .as_array()
            .and_then(|a| a.iter().find(|f| f["id"] == id))
            .and_then(|f| f["name"].as_str())
            .map(String::from)
    };
    Ok(json!({ "user": me["displayName"], "email": me["emailAddress"],
               "spName": name_of(&j.sp_field), "teamName": name_of(&j.team_field) }))
}

pub const CREDENTIALS_TEMPLATE: &str = "# Jira People Board — credentials
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

/// Write the template at `path`, readable only by the user. Never over a file that has content.
pub fn write_template(path: &Path) -> Result<()> {
    if fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false) {
        return Err(AppError::Other(format!("{} already has content — not overwriting it", path.display())));
    }
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        o.mode(0o600);
        // `mode` only applies to a new file: an empty file the Save dialog left behind gets 0600 too.
        if path.exists() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
    }
    use std::io::Write;
    o.open(path)
        .and_then(|mut f| f.write_all(CREDENTIALS_TEMPLATE.as_bytes()))
        .map_err(|e| AppError::Other(format!("Couldn't write {}: {e}", path.display())))
}

/// Settings → New template…: create the credentials file, then open it in the default text editor.
#[tauri::command]
pub fn credentials_template(path: String) -> Result<()> {
    let p = PathBuf::from(&path);
    write_template(&p)?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-t")
        .arg(&p)
        .spawn()
        .map_err(|e| AppError::Other(format!("Created, but couldn't open it: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_must_be_https_atlassian() {
        assert_eq!(check_site("https://acme.atlassian.net/").unwrap(), "https://acme.atlassian.net");
        assert_eq!(check_site(" https://ACME.atlassian.net ").unwrap(), "https://acme.atlassian.net");
        for bad in [
            "http://acme.atlassian.net",
            "https://evil.example.com",
            "https://acme.atlassian.net.evil.com",
            "https://acme.atlassian.net/wiki",
            "https://acme.atlassian.net:8443",
            "acme.atlassian.net",
        ] {
            assert!(check_site(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn jql_clause_for_custom_fields() {
        assert_eq!(jql_clause("customfield_12345"), "cf[12345]");
        assert_eq!(jql_clause("customfield_"), "customfield_");
        assert_eq!(jql_clause("Team"), "Team");
    }

    #[test]
    fn env_file_parsing() {
        let e = parse_env("# c\nexport A=\"1\"\nB = '2'\n\nC=x=y\nbroken\n");
        assert_eq!(e["A"], "1");
        assert_eq!(e["B"], "2");
        assert_eq!(e["C"], "x=y");
        assert_eq!(e.len(), 3);
    }

    #[test]
    fn template_is_private_and_never_overwrites() {
        let p = std::env::temp_dir().join("jpb-template-test.env");
        let _ = fs::remove_file(&p);
        fs::write(&p, "").unwrap(); // an empty file (left by the Save dialog) may be filled
        write_template(&p).unwrap();
        let t = fs::read_to_string(&p).unwrap();
        for k in ["ATLASSIAN_EMAIL=", "ATLASSIAN_API_TOKEN=", "ZOOM_WEBHOOK_URL=", "ZOOM_WEBHOOK_TOKEN="] {
            assert!(t.contains(k));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let err = write_template(&p).unwrap_err();
        assert!(err.message().contains("not overwriting"));
        let _ = fs::remove_file(&p);
    }
}
