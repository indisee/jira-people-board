//! Finding and running the Claude Code CLI (`claude -p`), and reading its answer.

use crate::error::{AppError, Result};
use serde_json::{json, Value};
use std::{
    path::Path,
    process::Stdio,
    sync::OnceLock,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command};

const TIMEOUT: Duration = Duration::from_secs(180);

/// The CLI to run: the path from Settings, else the auto-detected one.
pub fn find(custom: &str, home: &Path) -> Option<String> {
    let c = custom.trim();
    if !c.is_empty() {
        return Some(c.strip_prefix("~/").map(|r| home.join(r).to_string_lossy().into_owned()).unwrap_or_else(|| c.to_string()));
    }
    static AUTO: OnceLock<Option<String>> = OnceLock::new();
    AUTO.get_or_init(|| detect(home)).clone()
}

/// GUI apps don't get the login PATH: check the usual install spots, then ask the login shell (slow, so cached).
fn detect(home: &Path) -> Option<String> {
    for d in [home.join(".local/bin"), home.join(".claude/local"), "/opt/homebrew/bin".into(), "/usr/local/bin".into(), "/usr/bin".into()] {
        let p = d.join("claude");
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = std::process::Command::new(shell).args(["-lc", "command -v claude"]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// `claude -p` with no tools (ticket text is untrusted input), JSON output, in a neutral folder so no project
/// CLAUDE.md is pulled in. Killed after 3 minutes.
pub async fn run(exe: &str, model: &str, system: &str, input: String, dir: &Path) -> Result<Value> {
    tokio::fs::create_dir_all(dir).await?;
    let bin_dir = Path::new(exe).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let path = format!("{bin_dir}:/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default());
    let mut cmd = Command::new(exe);
    cmd.args(["-p", "--tools", "", "--output-format", "json", "--no-session-persistence", "--system-prompt", system]);
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    let mut child = cmd
        .current_dir(dir)
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Other(format!("Couldn't start claude ({exe}): {e}")))?;
    // Feed stdin while the output is being read, so neither side can fill a pipe and block the other.
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(input.as_bytes()).await;
        });
    }
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| AppError::Remote("claude took longer than 3 minutes and was stopped".into()))??;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let Ok(env) = serde_json::from_str::<Value>(&stdout) else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = [err, stdout].into_iter().find(|s| !s.is_empty()).unwrap_or_else(|| format!("claude exited with {}", out.status));
        return Err(AppError::Remote(msg));
    };
    if env["is_error"].as_bool().unwrap_or(false) {
        let r = env["result"].as_str().unwrap_or("");
        return Err(AppError::Remote(if r.is_empty() {
            format!("claude error ({})", env["subtype"].as_str().unwrap_or("unknown"))
        } else {
            r.to_string()
        }));
    }
    Ok(env)
}

/// The model is told to answer with bare JSON; tolerate a code fence or a sentence around it.
pub fn parse_answer(s: &str) -> Value {
    let t = s.trim();
    let body = match (t.find('{'), t.rfind('}')) {
        (Some(a), Some(b)) if b > a => &t[a..=b],
        _ => t,
    };
    let list = |v: &Value| -> Vec<String> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string()))
                    .filter(|s| !s.is_empty())
                    .take(6)
                    .collect()
            })
            .unwrap_or_default()
    };
    match serde_json::from_str::<Value>(body) {
        Ok(v) => {
            let ready = v["ready"].as_str().filter(|r| ["yes", "partly", "no"].contains(r)).unwrap_or("unknown");
            json!({ "ready": ready, "todo": v["todo"].as_str().unwrap_or(""),
                    "steps": list(&v["steps"]), "gaps": list(&v["gaps"]), "checks": list(&v["checks"]) })
        }
        Err(_) => json!({ "ready": "unknown", "todo": t, "steps": [], "gaps": [], "checks": [] }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_answers() {
        let v = parse_answer("```json\n{\"ready\":\"partly\",\"todo\":\"Do X\",\"steps\":[\"a\"],\"gaps\":[\"b\"],\"checks\":[\"c\"]}\n```");
        assert_eq!(v["ready"], "partly");
        assert_eq!(v["gaps"][0], "b");
        assert_eq!(v["checks"][0], "c");
        assert_eq!(parse_answer("just text")["ready"], "unknown");
        assert_eq!(parse_answer("{\"ready\":\"maybe\"}")["ready"], "unknown");
    }

    #[test]
    fn custom_path_expands_home() {
        assert_eq!(find("~/bin/claude", Path::new("/Users/x")).as_deref(), Some("/Users/x/bin/claude"));
    }

    /// A fake `claude`: a shell script with the given body.
    #[cfg(unix)]
    fn fake(name: &str, body: &str) -> (String, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("jpb-claude-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        (p.to_string_lossy().into_owned(), dir)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn feeds_stdin_and_reports_errors() {
        // Large input: more than a pipe buffer, to be sure writing and reading don't block each other.
        let big = "x".repeat(300_000);
        let (exe, dir) = fake("echo-err", "cat >&2; exit 1");
        let e = run(&exe, "", "sys", big.clone(), &dir).await.unwrap_err();
        assert_eq!(e.message().len(), big.len());

        let (exe, dir) = fake("ok", r#"cat >/dev/null; echo '{"result":"{\"ready\":\"yes\"}","total_cost_usd":0.01}'"#);
        let v = run(&exe, "sonnet", "sys", "in".into(), &dir).await.unwrap();
        assert_eq!(parse_answer(v["result"].as_str().unwrap())["ready"], "yes");

        let (exe, dir) = fake("is-error", r#"echo '{"is_error":true,"result":"Credit balance is too low"}'"#);
        assert_eq!(run(&exe, "", "s", "".into(), &dir).await.unwrap_err().message(), "Credit balance is too low");
    }
}
