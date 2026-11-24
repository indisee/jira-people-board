//! One error type for every command. It reaches the page as `{ kind, message }`, so the UI can tell
//! "fix your credentials" (auth / config) from a passing Jira or network failure without parsing strings.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", content = "message", rename_all = "lowercase")]
pub enum AppError {
    /// Jira rejected the token (401 / 403).
    Auth(String),
    /// Credentials file or settings are missing or wrong: the user has to fix Settings.
    Config(String),
    /// Jira (or Zoom, or claude) answered with an error.
    Remote(String),
    /// Anything else: bad input, file system, a bug.
    Other(String),
}

pub type Result<T> = std::result::Result<T, AppError>;

impl AppError {
    pub fn message(&self) -> &str {
        match self {
            AppError::Auth(m) | AppError::Config(m) | AppError::Remote(m) | AppError::Other(m) => m,
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_kind_and_message() {
        let v = serde_json::to_value(AppError::Config("no token".into())).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "config", "message": "no token" }));
    }
}
