//! `avatar://` protocol: Atlassian / Gravatar images fetched by the backend, so the API token never reaches the
//! page. The token is attached only for the configured Jira site (and Atlassian's own API host).

use crate::{
    error::{AppError, Result},
    AppState,
};
use percent_encoding::percent_decode_str;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{http::Response, Manager, UriSchemeContext, UriSchemeResponder};

const TTL: Duration = Duration::from_secs(6 * 3600);
const MAX_ENTRIES: usize = 500;

type Entry = (Instant, String, Vec<u8>);

#[derive(Default)]
pub struct Cache(Mutex<HashMap<String, Entry>>);

impl Cache {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn clear(&self) {
        self.map().clear();
    }

    fn get(&self, src: &str) -> Option<(String, Vec<u8>)> {
        self.map().get(src).filter(|(at, ..)| at.elapsed() < TTL).map(|(_, ct, b)| (ct.clone(), b.clone()))
    }

    fn put(&self, src: &str, ct: &str, bytes: &[u8]) {
        let mut m = self.map();
        if m.len() >= MAX_ENTRIES {
            m.retain(|_, (at, ..)| at.elapsed() < TTL);
            if m.len() >= MAX_ENTRIES {
                m.clear();
            }
        }
        m.insert(src.to_string(), (Instant::now(), ct.to_string(), bytes.to_vec()));
    }
}

/// Which hosts may be fetched at all, and which of them get the API token.
pub fn host_policy(host: &str, site_host: &str) -> (bool, bool) {
    let auth = host == site_host || host == "api.atlassian.com";
    let allowed = auth || host.ends_with(".atl-paas.net") || host == "secure.gravatar.com";
    (allowed, auth)
}

async fn fetch(state: &AppState, src: &str) -> Result<(String, Vec<u8>)> {
    if let Some(hit) = state.avatars.get(src) {
        return Ok(hit);
    }
    let url = tauri::Url::parse(src).map_err(|e| AppError::Other(e.to_string()))?;
    let c = state.conn()?;
    let (allowed, auth) = host_policy(url.host_str().unwrap_or(""), c.jira.host());
    if url.scheme() != "https" || !allowed {
        return Err(AppError::Other("host not allowed".into()));
    }
    let mut rb = c.jira.client.get(url);
    if auth {
        rb = rb.header("Authorization", c.jira.auth_header());
    }
    let r = rb.send().await.map_err(|e| AppError::Remote(e.to_string()))?;
    if !r.status().is_success() {
        return Err(AppError::Remote(r.status().to_string()));
    }
    let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("image/png").to_string();
    if !ct.starts_with("image/") {
        return Err(AppError::Remote(format!("not an image: {ct}")));
    }
    let bytes = r.bytes().await.map_err(|e| AppError::Remote(e.to_string()))?.to_vec();
    state.avatars.put(src, &ct, &bytes);
    Ok((ct, bytes))
}

/// Handler for `register_asynchronous_uri_scheme_protocol("avatar", …)`. The path is the percent-encoded image URL.
pub fn handle<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let path = request.uri().path().trim_start_matches('/').to_string();
    tauri::async_runtime::spawn(async move {
        let src = percent_decode_str(&path).decode_utf8_lossy().to_string();
        let state = app.state::<AppState>();
        let resp = match fetch(&state, &src).await {
            Ok((ct, bytes)) => Response::builder()
                .header("Content-Type", ct)
                .header("Cache-Control", "max-age=21600")
                .body(bytes),
            Err(_) => Response::builder().status(404).body(Vec::new()),
        };
        responder.respond(resp.unwrap_or_else(|_| Response::new(Vec::new())));
    });
}

#[cfg(test)]
mod tests {
    use super::host_policy;

    #[test]
    fn token_only_for_own_site() {
        let site = "acme.atlassian.net";
        assert_eq!(host_policy("acme.atlassian.net", site), (true, true));
        assert_eq!(host_policy("api.atlassian.com", site), (true, true));
        assert_eq!(host_policy("other.atlassian.net", site), (false, false));
        assert_eq!(host_policy("x.prod.public.atl-paas.net", site), (true, false));
        assert_eq!(host_policy("secure.gravatar.com", site), (true, false));
        assert_eq!(host_policy("evil.com", site), (false, false));
    }
}
