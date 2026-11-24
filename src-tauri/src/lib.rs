//! Jira People Board — Tauri backend.
//!
//! - config:  Settings + credentials file (ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN, optional Zoom webhook)
//! - jira:    REST client and the board's search commands
//! - storage: people / daily notes / memo files in the app data folder
//! - brief:   per-ticket "what to do, is it ready" from `claude -p`
//! - zoom:    daily report to a Zoom channel
//! - avatar:  `avatar://` image proxy, so the API token never reaches the page
//! - window:  menu bar and the Settings window

mod avatar;
mod brief;
mod config;
mod error;
mod jira;
mod storage;
mod time;
mod window;
mod zoom;

use error::Result;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, RwLock},
};
use tauri::Manager;

pub struct AppState {
    /// Rebuilt when Settings are saved, so a new credentials file or field id applies without a restart.
    conn: RwLock<Result<Arc<config::Connection>>>,
    avatars: avatar::Cache,
    home: PathBuf,
}

impl AppState {
    fn new(home: PathBuf, settings: &Value) -> Self {
        let conn = config::load(&home, settings).map(Arc::new);
        AppState { conn: RwLock::new(conn), avatars: avatar::Cache::default(), home }
    }

    pub fn conn(&self) -> Result<Arc<config::Connection>> {
        self.conn.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn reconnect(&self, settings: &Value) {
        *self.conn.write().unwrap_or_else(|e| e.into_inner()) = config::load(&self.home, settings).map(Arc::new);
        self.avatars.clear();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let home = app.path().home_dir().unwrap_or_default();
            // Asking the login shell where `claude` lives is slow: do it now, off the main thread.
            let h = home.clone();
            std::thread::spawn(move || brief::claude::find("", &h));
            app.manage(AppState::new(home, &config::settings_read(app.handle())));
            app.set_menu(window::build_menu(app.handle())?)?;
            app.on_menu_event(|app, e| {
                if e.id() == "settings" {
                    window::show_settings(app);
                }
            });
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("avatar", avatar::handle)
        .invoke_handler(tauri::generate_handler![
            storage::people_load,
            storage::people_save,
            storage::notes_load,
            storage::notes_put,
            storage::memo_load,
            storage::memo_save,
            config::config_get,
            config::config_save,
            config::config_check,
            config::credentials_template,
            jira::users_search,
            jira::projects_search,
            jira::teams_search,
            jira::issues_search,
            brief::ticket_brief,
            brief::brief_cache,
            zoom::zoom_send,
            window::open_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jira People Board");
}
