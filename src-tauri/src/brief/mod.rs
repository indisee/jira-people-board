//! Ticket brief: a very short "what to do, and is it ready for development" per ticket, from `claude -p`.
//! text.rs turns the ticket into plain text, claude.rs runs the CLI, this file caches answers in briefs.json.

pub mod claude;
pub mod text;

use crate::{
    config::setting,
    error::{AppError, Result},
    jira::Jira,
    storage, AppState,
};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::Arc};
use tauri::State;

/// Built-in prompt; Settings → "Prompt" can replace it.
pub const DEFAULT_PROMPT: &str = include_str!("prompt.md");
pub const DEFAULT_MODEL: &str = "sonnet";
pub const DEFAULT_LANGUAGE: &str = "English";

pub struct Options {
    /// System prompt; empty = DEFAULT_PROMPT. "{{LANGUAGE}}" is replaced with `language`.
    pub prompt: String,
    pub model: String,
    pub language: String,
    pub claude_path: String,
    pub force: bool,
}

/// Short fingerprint of the prompt, so cached briefs are redone when it changes.
fn prompt_id(system: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in system.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("{:x}", h & 0xffff_ffff)
}

/// "ABC-123": an upper-case project key, a dash, digits. Keeps arbitrary text out of the JQL and URLs.
pub fn valid_key(key: &str) -> bool {
    let Some((p, n)) = key.split_once('-') else { return false };
    p.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && p.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !n.is_empty()
        && n.chars().all(|c| c.is_ascii_digit())
}

/// Everything answered so far, so rows can show their verdict right after a restart.
pub fn cached(cache_file: &Path) -> Value {
    storage::read_json(cache_file, json!({}))
}

fn is_fresh(hit: &Value, updated: &str, o: &Options, pid: &str) -> bool {
    hit["updated"] == updated && hit["model"] == o.model.as_str() && hit["language"] == o.language.as_str() && hit["prompt"] == pid
}

/// One brief per key at a time: a second request for the same ticket waits for the first and reuses its answer.
fn key_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::Mutex<Option<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = std::sync::Mutex::new(None);
    let mut m = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    m.get_or_insert_with(HashMap::new).entry(key.to_string()).or_default().clone()
}

/// Ticket key → brief. Reuses the cached one while the ticket, model, language and prompt are unchanged.
pub async fn brief(j: &Jira, key: &str, o: Options, cache_file: &Path, work_dir: &Path, home: &Path) -> Result<Value> {
    let key = key.trim().to_uppercase();
    if !valid_key(&key) {
        return Err(AppError::Other("Not a ticket key".into()));
    }
    let asked_at = crate::time::now_iso();
    let lock = key_lock(&key);
    let _turn = lock.lock().await;
    // Someone else answered this ticket while we waited: that answer is as fresh as ours would be.
    let hit = cached(cache_file)[&key].clone();
    if hit["at"].as_str().is_some_and(|at| at >= asked_at.as_str()) {
        return Ok(with_cached(hit, true));
    }

    let (issue, input) = text::collect(j, &key).await?;
    let f = &issue["fields"];
    let ikey = issue["key"].as_str().unwrap_or(&key).to_string();
    let updated = f["updated"].as_str().unwrap_or("").to_string();
    let system = if o.prompt.trim().is_empty() { DEFAULT_PROMPT } else { o.prompt.as_str() }.replace("{{LANGUAGE}}", &o.language);
    let pid = prompt_id(&system);
    let hit = cached(cache_file)[&ikey].clone();
    if !o.force && is_fresh(&hit, &updated, &o, &pid) {
        return Ok(with_cached(hit, true));
    }

    let exe = claude::find(&o.claude_path, home)
        .ok_or_else(|| AppError::Config("Claude Code CLI not found. Install it, or set its path in Settings → Claude path.".into()))?;
    let env = claude::run(&exe, &o.model, &system, input, work_dir).await?;
    let mut res = claude::parse_answer(env["result"].as_str().unwrap_or(""));
    for (k, v) in [
        ("key", json!(ikey)),
        ("summary", f["summary"].clone()),
        ("status", f["status"]["name"].clone()),
        ("updated", json!(updated)),
        ("at", json!(crate::time::now_iso())),
        ("model", json!(o.model)),
        ("language", json!(o.language)),
        ("prompt", json!(pid)),
        ("cost", env["total_cost_usd"].clone()),
        ("ms", env["duration_ms"].clone()),
    ] {
        res[k] = v;
    }
    {
        // Re-read under the lock right before writing: other briefs may have finished meanwhile.
        let _g = storage::WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut fresh = cached(cache_file);
        fresh[&ikey] = res.clone();
        storage::write_json(cache_file, &fresh)?;
    }
    Ok(with_cached(res, false))
}

fn with_cached(mut v: Value, cached: bool) -> Value {
    v["cached"] = json!(cached);
    v
}

/// Settings: briefModel, briefLanguage, claudePath, briefPrompt.
#[tauri::command]
pub async fn ticket_brief(app: tauri::AppHandle, state: State<'_, AppState>, key: String, force: Option<bool>) -> Result<Value> {
    let c = state.conn()?;
    let s = crate::config::settings_read(&app);
    let opts = Options {
        model: setting(&s, "briefModel").unwrap_or_else(|| DEFAULT_MODEL.into()),
        language: setting(&s, "briefLanguage").unwrap_or_else(|| DEFAULT_LANGUAGE.into()),
        claude_path: setting(&s, "claudePath").unwrap_or_default(),
        prompt: setting(&s, "briefPrompt").unwrap_or_default(),
        force: force.unwrap_or(false),
    };
    let dir = storage::data_dir(&app)?;
    brief(&c.jira, &key, opts, &dir.join("briefs.json"), &dir.join("brief-work"), &state.home).await
}

#[tauri::command]
pub fn brief_cache(app: tauri::AppHandle) -> Result<Value> {
    Ok(cached(&storage::data_file(&app, "briefs.json")?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        assert!(valid_key("ABC-123"));
        assert!(valid_key("A1_B-7"));
        assert!(!valid_key("abc-1"));
        assert!(!valid_key("ABC-"));
        assert!(!valid_key("ABC-1) OR 1=1"));
        assert!(!valid_key("ABC-1-2"));
    }

    #[test]
    fn prompt_change_invalidates() {
        let o = Options { prompt: String::new(), model: "sonnet".into(), language: "English".into(), claude_path: String::new(), force: false };
        let hit = json!({ "updated": "u1", "model": "sonnet", "language": "English", "prompt": prompt_id("a") });
        assert!(is_fresh(&hit, "u1", &o, &prompt_id("a")));
        assert!(!is_fresh(&hit, "u1", &o, &prompt_id("b")));
        assert!(!is_fresh(&hit, "u2", &o, &prompt_id("a")));
    }
}

/// Live check against Jira + claude: `cargo test --lib live_brief -- --ignored --nocapture` (key in BRIEF_KEY).
#[cfg(test)]
mod live {
    #[tokio::test]
    #[ignore]
    async fn live_brief() {
        let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
        let conn = crate::config::load(&home, &serde_json::json!({})).unwrap();
        let tmp = std::env::temp_dir().join("jpb-brief-test");
        let o = super::Options { prompt: String::new(), model: "sonnet".into(), language: "English".into(), claude_path: String::new(), force: true };
        let key = std::env::var("BRIEF_KEY").unwrap_or_else(|_| "ABC-123".into());
        let v = super::brief(&conn.jira, &key, o, &tmp.join("cache.json"), &tmp, &home).await.unwrap();
        println!("{}", serde_json::to_string_pretty(&v).unwrap());
    }
}
