//! Files in the app data folder: people.json (board rows, in board order), notes.json (daily notes),
//! memo.txt (header notes), settings.json and briefs.json. Every write goes to a temp file first and is
//! renamed into place, so a crash never leaves a half-written file.

use crate::error::{AppError, Result};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

/// Serializes read-modify-write cycles on the data files (notes, the brief cache).
pub static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn data_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf> {
    Ok(data_dir(app)?.join(name))
}

/// The file's JSON, or `default` when it is missing, unreadable or of another shape.
pub fn read_json(path: &Path, default: Value) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| std::mem::discriminant(v) == std::mem::discriminant(&default))
        .unwrap_or(default)
}

pub fn write_atomic(path: &Path, data: &[u8]) -> Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn write_json(path: &Path, v: &Value) -> Result<()> {
    write_atomic(path, serde_json::to_string_pretty(v)?.as_bytes())
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/* ---------- people ---------- */

#[tauri::command]
pub fn people_load(app: tauri::AppHandle) -> Result<Value> {
    Ok(read_json(&data_file(&app, "people.json")?, json!([])))
}

#[tauri::command]
pub fn people_save(app: tauri::AppHandle, list: Value) -> Result<()> {
    if !list.is_array() {
        return Err(AppError::Other("Expected a list".into()));
    }
    write_json(&data_file(&app, "people.json")?, &list)
}

/* ---------- daily notes: {"YYYY-MM-DD": {rowId: {done, doing, at}}} ---------- */

#[tauri::command]
pub fn notes_load(app: tauri::AppHandle) -> Result<Value> {
    Ok(read_json(&data_file(&app, "notes.json")?, json!({})))
}

fn valid_day(day: &str) -> bool {
    let b = day.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// Upsert one person's entry for one day; an entry with both fields empty is removed.
pub fn notes_apply(all: &mut Value, day: &str, id: &str, done: &str, doing: &str, at: u64) {
    if !all.is_object() {
        *all = json!({});
    }
    let map = all.as_object_mut().expect("object");
    let dayv = map.entry(day.to_string()).or_insert_with(|| json!({}));
    if !dayv.is_object() {
        *dayv = json!({});
    }
    let d = dayv.as_object_mut().expect("object");
    if done.trim().is_empty() && doing.trim().is_empty() {
        d.remove(id);
    } else {
        d.insert(id.to_string(), json!({ "done": done, "doing": doing, "at": at }));
    }
    if d.is_empty() {
        map.remove(day);
    }
}

#[tauri::command]
pub fn notes_put(app: tauri::AppHandle, day: String, id: String, done: String, doing: String) -> Result<()> {
    if !valid_day(&day) || id.trim().is_empty() {
        return Err(AppError::Other("Expected a day (YYYY-MM-DD) and a row id".into()));
    }
    let path = data_file(&app, "notes.json")?;
    let _g = lock();
    let mut all = read_json(&path, json!({}));
    notes_apply(&mut all, &day, &id, &done, &doing, crate::time::now_ms());
    write_json(&path, &all)
}

/* ---------- header memo ---------- */

#[tauri::command]
pub fn memo_load(app: tauri::AppHandle) -> Result<Option<String>> {
    let path = data_file(&app, "memo.txt")?;
    // None (not "") when there is no file yet, so the page can bring over a memo kept by an older version.
    Ok(fs::read_to_string(path).ok())
}

#[tauri::command]
pub fn memo_save(app: tauri::AppHandle, text: String) -> Result<()> {
    write_atomic(&data_file(&app, "memo.txt")?, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_upsert_and_remove() {
        let mut all = json!({});
        notes_apply(&mut all, "2026-11-24", "a", "x", "", 1);
        assert_eq!(all["2026-11-24"]["a"]["done"], "x");
        notes_apply(&mut all, "2026-11-24", "a", " ", "", 2);
        assert_eq!(all, json!({}));
    }

    #[test]
    fn day_format() {
        assert!(valid_day("2026-11-24"));
        assert!(!valid_day("2026-1-24"));
        assert!(!valid_day("../../etc"));
    }

    #[test]
    fn atomic_write_and_typed_read() {
        let p = std::env::temp_dir().join("jpb-storage-test.json");
        write_json(&p, &json!([1, 2])).unwrap();
        assert_eq!(read_json(&p, json!([])), json!([1, 2]));
        assert_eq!(read_json(&p, json!({})), json!({}), "wrong shape falls back to the default");
        let _ = fs::remove_file(&p);
    }
}
