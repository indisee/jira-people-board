//! macOS menu bar and the separate Settings window.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Manager, WebviewUrl, WebviewWindowBuilder,
};

const SETTINGS_W: f64 = 600.0;

/// Open (or bring forward) the Settings window: App menu → Settings… (⌘,).
pub fn show_settings(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let mut b = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html?view=settings".into()))
        .title("Settings")
        .inner_size(SETTINGS_W, 780.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .disable_drag_drop_handler();
    // Centered over the board window, a little below its title bar.
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(size), Ok(scale)) = (main.outer_position(), main.outer_size(), main.scale_factor()) {
            let (x, y) = (pos.x as f64 / scale, pos.y as f64 / scale);
            let w = size.width as f64 / scale;
            b = b.position(x + (w - SETTINGS_W) / 2.0, y + 80.0);
        }
    }
    let _ = b.build();
}

#[tauri::command]
pub fn open_settings(app: tauri::AppHandle) {
    show_settings(&app);
}

/// App menu with Settings… ⌘, plus the standard Edit and Window menus
/// (Edit keeps ⌘C / ⌘V / ⌘Z working in text fields once a custom menu is set).
pub fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Jira People Board",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &sep()?,
            &settings,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
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
            &sep()?,
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
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}
