//! Jira REST client and the board's search commands (people, teams, projects, tickets).

use crate::{
    config::jql_clause,
    error::{AppError, Result},
    AppState,
};
use base64::Engine;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::Method;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::State;

pub struct Jira {
    pub client: reqwest::Client,
    /// "https://acme.atlassian.net", checked by `config::check_site`.
    pub site: String,
    auth: String,
    pub sp_field: String,
    pub team_field: String,
    pub team_clause: String,
}

pub fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

/// Jira's error text: `errorMessages`, else `message`, else the status.
fn error_text(v: &Value, status: reqwest::StatusCode) -> String {
    v["errorMessages"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("; "))
        .filter(|s| !s.is_empty())
        .or_else(|| v["message"].as_str().map(String::from))
        .unwrap_or_else(|| format!("Jira returned {status}"))
}

impl Jira {
    pub fn new(site: String, email: &str, token: &str, sp_field: String, team_field: String) -> Result<Self> {
        let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{email}:{token}")));
        let client = reqwest::Client::builder()
            .user_agent("jira-people-board")
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| AppError::Other(e.to_string()))?;
        Ok(Jira { client, site, auth, sp_field, team_clause: jql_clause(&team_field), team_field })
    }

    /// The site's host, the only one the API token is sent to.
    pub fn host(&self) -> &str {
        self.site.trim_start_matches("https://")
    }

    pub fn auth_header(&self) -> &str {
        &self.auth
    }

    pub async fn req(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut rb = self
            .client
            .request(method, format!("{}{}", self.site, path))
            .header("Authorization", &self.auth)
            .header("Accept", "application/json");
        if let Some(b) = body {
            rb = rb.json(&b);
        }
        let r = rb.send().await.map_err(|e| AppError::Remote(format!("Couldn't reach Jira: {e}")))?;
        let status = r.status();
        let text = r.text().await.map_err(|e| AppError::Remote(e.to_string()))?;
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(AppError::Auth("Jira rejected the API token".into()));
        }
        let v: Value = serde_json::from_str(&text)
            .unwrap_or_else(|_| json!({ "message": text.chars().take(300).collect::<String>() }));
        if !status.is_success() {
            return Err(AppError::Remote(error_text(&v, status)));
        }
        Ok(v)
    }

    pub async fn get(&self, path: &str) -> Result<Value> {
        self.req(Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.req(Method::POST, path, Some(body)).await
    }

    /// `POST /search/jql` with the given fields.
    pub async fn search(&self, jql: &str, max: usize, fields: &[&str]) -> Result<Value> {
        self.post("/rest/api/3/search/jql", json!({ "jql": jql, "maxResults": max, "fields": fields })).await
    }
}

fn items(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

/// "<b>Team</b> A" -> "Team A" (JQL suggestions highlight the match).
fn strip_tags(s: &str) -> String {
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
}

#[tauri::command]
pub async fn users_search(state: State<'_, AppState>, q: String) -> Result<Value> {
    let c = state.conn()?;
    let v = c.jira.get(&format!("/rest/api/3/user/search?maxResults=20&query={}", enc(&q))).await?;
    let out: Vec<Value> = items(&v)
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

/// Teams (the Team field) matching `q`, via JQL value suggestions.
#[tauri::command]
pub async fn teams_search(state: State<'_, AppState>, q: String) -> Result<Value> {
    let c = state.conn()?;
    let j = &c.jira;
    if j.team_clause.is_empty() {
        return Err(AppError::Config("The Team field is not set".into()));
    }
    let v = j
        .get(&format!(
            "/rest/api/3/jql/autocompletedata/suggestions?fieldName={}&fieldValue={}",
            enc(&j.team_clause),
            enc(&q)
        ))
        .await?;
    let out: Vec<Value> = items(&v["results"])
        .into_iter()
        .map(|t| json!({ "teamId": t["value"], "displayName": strip_tags(t["displayName"].as_str().unwrap_or("")) }))
        .collect();
    Ok(Value::Array(out))
}

#[tauri::command]
pub async fn projects_search(state: State<'_, AppState>, q: String) -> Result<Value> {
    let c = state.conn()?;
    let v = c
        .jira
        .get(&format!("/rest/api/3/project/search?maxResults=50&action=browse&orderBy=name&query={}", enc(&q)))
        .await?;
    let out: Vec<Value> = items(&v["values"]).into_iter().map(|p| json!({ "key": p["key"], "name": p["name"] })).collect();
    Ok(Value::Array(out))
}

/// One board row's tickets. With `assignee`, each ticket also gets when it was last assigned to that person.
#[tauri::command]
pub async fn issues_search(
    state: State<'_, AppState>,
    jql: String,
    max_results: Option<u32>,
    assignee: Option<String>,
) -> Result<Value> {
    let c = state.conn()?;
    let j = &c.jira;
    let mut fields = vec!["summary", "status", "issuetype", "priority", "project", "created", "updated", "assignee"];
    if !j.sp_field.is_empty() {
        fields.push(&j.sp_field);
    }
    let r = j.search(&jql, max_results.unwrap_or(100).min(100) as usize, &fields).await?;
    let issues = items(&r["issues"]);
    let since = match &assignee {
        Some(a) => {
            let ids: Vec<String> = issues.iter().filter_map(|n| n["id"].as_str().map(String::from)).collect();
            assigned_since(j, &ids, a).await.unwrap_or_else(|e| {
                eprintln!("assignment history unavailable: {e}");
                HashMap::new()
            })
        }
        None => HashMap::new(),
    };
    let out: Vec<Value> = issues
        .iter()
        .map(|n| {
            let f = &n["fields"];
            let key = n["key"].as_str().unwrap_or("");
            let created = f["created"].as_str().unwrap_or("");
            let hist = n["id"].as_str().and_then(|id| since.get(id)).copied();
            // No assignee change in the history means the ticket was assigned when it was created.
            let assigned_at = match (hist, &assignee) {
                (Some(ms), _) => json!(crate::time::iso_from_ms(ms)),
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
                "sp": if j.sp_field.is_empty() { None } else { f[&j.sp_field].as_f64() },
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
    Ok(json!({ "issues": out, "more": more, "url": format!("{}/issues/?jql={}", j.site, enc(&jql)) }))
}

/// When each issue was last assigned to `account_id`, from the bulk changelog (epoch ms by issue id).
async fn assigned_since(j: &Jira, ids: &[String], account_id: &str) -> Result<HashMap<String, i64>> {
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
        let r = j.post("/rest/api/3/changelog/bulkfetch", body).await?;
        for il in items(&r["issueChangeLogs"]) {
            let Some(id) = il["issueId"].as_str() else { continue };
            for h in items(&il["changeHistories"]) {
                let t = h["created"].as_i64().unwrap_or(0);
                let to_me = h["items"].as_array().is_some_and(|items| {
                    items.iter().any(|i| {
                        (i["fieldId"] == "assignee" || i["field"] == "assignee") && i["to"].as_str() == Some(account_id)
                    })
                });
                if to_me && out.get(id).is_none_or(|&prev| t > prev) {
                    out.insert(id.to_string(), t);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_suggestion_markup() {
        assert_eq!(strip_tags("<b>Pla</b>tform team"), "Platform team");
    }

    #[test]
    fn host_is_the_site_without_scheme() {
        let j = Jira::new("https://acme.atlassian.net".into(), "a@b.c", "t", "cf1".into(), "customfield_1".into()).unwrap();
        assert_eq!(j.host(), "acme.atlassian.net");
        assert_eq!(j.team_clause, "cf[1]");
    }
}
