//! Daily report → Zoom Team Chat channel through an incoming webhook.

use crate::{
    error::{AppError, Result},
    AppState,
};
use serde_json::Value;
use tauri::State;

const ZOOM_PREFIX: &str = "https://integrations.zoom.us/";

/// Post the report: rich ("full") format first, plain text if Zoom rejects it. Returns the format accepted.
#[tauri::command]
pub async fn zoom_send(state: State<'_, AppState>, full: Value, text: String) -> Result<String> {
    let c = state.conn()?;
    let (url, token) = c.zoom.as_ref().ok_or_else(|| {
        AppError::Config("ZOOM_WEBHOOK_URL / ZOOM_WEBHOOK_TOKEN are missing in the credentials file".into())
    })?;
    if !url.starts_with(ZOOM_PREFIX) {
        return Err(AppError::Config(format!("ZOOM_WEBHOOK_URL must be a {ZOOM_PREFIX} webhook")));
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    let post = |format: &str, body: String| {
        c.jira
            .client
            .post(format!("{url}{sep}format={format}"))
            .header("Authorization", token)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
    };
    let net = |e: reqwest::Error| AppError::Remote(format!("Couldn't reach Zoom: {e}"));
    let r = post("full", full.to_string()).await.map_err(net)?;
    if r.status().is_success() {
        return Ok("full".into());
    }
    let r = post("message", text).await.map_err(net)?;
    if r.status().is_success() {
        return Ok("message".into());
    }
    let status = r.status();
    let body = r.text().await.unwrap_or_default();
    Err(AppError::Remote(format!("Zoom returned {status}: {}", body.chars().take(200).collect::<String>())))
}
