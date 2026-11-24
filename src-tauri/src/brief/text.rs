//! A Jira ticket with its parent, links, children and comments → one plain-text document for Claude.

use crate::{error::Result, jira::Jira};
use serde_json::Value;
use std::collections::HashMap;

// Generous on purpose: what is cut here Claude can't see (≈ 4 chars per token; 120k chars ≈ 30k tokens).
const DESC: usize = 30000;
const PARENT_DESC: [usize; 2] = [20000, 8000];
const FIELD: usize = 5000;
const PARENT_COMMENTS: usize = 5;
const COMMENT: usize = 2500;
const COMMENTS: usize = 15;
const RELATED: usize = 2500;
const CHILDREN: usize = 30;
const TOTAL: usize = 120000;
/// The prompt tells Claude that this marker is ours, never a problem of the ticket.
pub const CUT_MARK: &str = " …[SHORTENED BY THE BOARD]";

const LINKED_FIELDS: &[&str] = &["summary", "status", "issuetype", "description", "assignee"];
/// Custom fields that only add noise to the brief (matched by their display name).
const SKIP_FIELDS: &[&str] = &["rank", "team", "development", "start date", "sprint", "story point estimate", "flagged"];

/* ---------- Atlassian Document Format → text ---------- */

/// Paragraph-like nodes end lines; list items get "- ", nested lists are indented.
fn adf(n: &Value, depth: usize) -> String {
    if let Some(a) = n.as_array() {
        return a.iter().map(|x| adf(x, depth)).collect();
    }
    if let Some(s) = n.as_str() {
        return s.to_string();
    }
    if !n.is_object() {
        return String::new(); // a leaf without "content" (e.g. "rule")
    }
    let t = n["type"].as_str().unwrap_or("");
    let attr = |k: &str| n["attrs"][k].as_str().unwrap_or("").to_string();
    let nested = if t == "bulletList" || t == "orderedList" { depth + 1 } else { depth };
    let kids = || adf(&n["content"], nested);
    match t {
        "text" => n["text"].as_str().unwrap_or("").to_string(),
        "hardBreak" => "\n".into(),
        "mention" => Some(attr("text")).filter(|s| !s.is_empty()).unwrap_or_else(|| "@someone".into()),
        "emoji" => Some(attr("text")).filter(|s| !s.is_empty()).unwrap_or_else(|| attr("shortName")),
        "date" => n["attrs"]["timestamp"]
            .as_str()
            .and_then(|s| s.parse::<i64>().ok())
            .map(|ms| crate::time::iso_from_ms(ms)[..10].to_string())
            .unwrap_or_default(),
        "inlineCard" => attr("url"),
        "blockCard" | "embedCard" => attr("url") + "\n",
        "status" => format!("[{}]", attr("text")),
        "media" => "[image]\n".into(),
        "listItem" => format!("{}- {}\n", "  ".repeat(depth.saturating_sub(1)), kids().trim()),
        "taskItem" => format!("{}{}\n", if attr("state") == "DONE" { "[x] " } else { "[ ] " }, kids().trim()),
        "heading" => {
            let level = n["attrs"]["level"].as_u64().unwrap_or(2) as usize;
            format!("\n{} {}\n", "#".repeat(level), kids().trim())
        }
        "codeBlock" => format!("```\n{}\n```\n", kids()),
        "tableRow" => {
            let cells: Vec<String> = n["content"]
                .as_array()
                .map(|a| a.iter().map(|c| adf(&c["content"], depth).trim().replace('\n', " ")).collect())
                .unwrap_or_default();
            format!("| {} |\n", cells.join(" | "))
        }
        "paragraph" => kids() + "\n",
        _ => kids(),
    }
}

/// ADF document or plain string → text with at most one blank line in a row.
pub fn text(v: &Value) -> String {
    let s = if v["type"] == "doc" { adf(v, 0) } else { v.as_str().unwrap_or("").to_string() };
    let mut out = String::new();
    let mut blank = 0;
    for line in s.trim().lines() {
        blank = if line.trim().is_empty() { blank + 1 } else { 0 };
        if blank < 2 {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

pub fn cut(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}{CUT_MARK}", &s[..i]),
        None => s.to_string(),
    }
}

fn day(v: &Value) -> String {
    v.as_str().map(|s| s.chars().take(10).collect()).unwrap_or_default()
}

fn str_of<'a>(v: &'a Value, or: &'a str) -> &'a str {
    v.as_str().unwrap_or(or)
}

fn join_names(v: &Value, k: &str) -> String {
    v.as_array().map(|a| a.iter().filter_map(|x| x[k].as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default()
}

/// The id of the custom field named `name` (e.g. "Sprint"), from the issue's `names` expansion.
fn field_id(issue: &Value, name: &str) -> Option<String> {
    issue["names"].as_object()?.iter().find(|(_, v)| v.as_str() == Some(name)).map(|(k, _)| k.clone())
}

/// Custom fields worth showing: rich text (acceptance criteria…), option values/names, plain text, links.
fn custom_text(v: &Value) -> String {
    match v {
        Value::Null | Value::Bool(_) | Value::Number(_) => String::new(),
        // Dev-panel blobs like "{pullrequest={…}}" are noise.
        Value::String(s) if s.starts_with('{') && s.ends_with('}') && s.contains('=') => String::new(),
        Value::String(s) => s.trim().to_string(),
        Value::Array(a) => a.iter().map(custom_text).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "),
        Value::Object(_) if v["type"] == "doc" => text(v),
        Value::Object(_) => ["value", "name", "displayName"].iter().find_map(|k| v[*k].as_str()).unwrap_or("").to_string(),
    }
}

fn extra_fields(issue: &Value, sp_field: &str) -> Vec<(String, String)> {
    let mut extra: Vec<(String, String)> = issue["fields"]
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(k, _)| k.starts_with("customfield_") && k.as_str() != sp_field)
                .map(|(k, v)| (str_of(&issue["names"][k], k).to_string(), custom_text(v)))
                .filter(|(n, v)| !v.is_empty() && !SKIP_FIELDS.contains(&n.to_lowercase().as_str()))
                .collect()
        })
        .unwrap_or_default();
    extra.sort();
    extra
}

fn field_lines(extra: &[(String, String)]) -> String {
    extra.iter().map(|(n, v)| format!("{n}: {}", cut(v, FIELD))).collect::<Vec<_>>().join("\n")
}

fn comment_lines(comments: &[Value]) -> String {
    comments
        .iter()
        .map(|c| format!("- {}, {}: {}", str_of(&c["author"]["displayName"], "?"), day(&c["created"]), cut(&text(&c["body"]), COMMENT)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn last<T>(all: &[T], n: usize) -> &[T] {
    &all[all.len().saturating_sub(n)..]
}

/// "KEY [Type · Status ✓] Summary" for a linked or child ticket.
fn rel(i: &Value) -> String {
    let f = &i["fields"];
    let done = f["status"]["statusCategory"]["key"] == "done";
    format!(
        "{} [{} · {}{}] {}",
        str_of(&i["key"], "?"),
        str_of(&f["issuetype"]["name"], "?"),
        str_of(&f["status"]["name"], "?"),
        if done { " ✓" } else { "" },
        str_of(&f["summary"], "")
    )
}

fn rel_desc(i: Option<&Value>) -> String {
    let d = i.map(|i| text(&i["fields"]["description"])).unwrap_or_default();
    if d.is_empty() {
        String::new()
    } else {
        format!("\n    {}", cut(&d, RELATED).replace('\n', "\n    "))
    }
}

async fn search(j: &Jira, jql: String, max: usize) -> Vec<Value> {
    j.search(&jql, max, LINKED_FIELDS).await.ok().and_then(|r| r["issues"].as_array().cloned()).unwrap_or_default()
}

async fn issue_full(j: &Jira, key: &str) -> Result<Value> {
    j.get(&format!("/rest/api/3/issue/{}?fields=*all&expand=names", crate::jira::enc(key))).await
}

/// Parent and grandparent (story → epic): children often keep the real requirements there.
async fn ancestors(j: &Jira, f: &Value) -> Vec<String> {
    let mut out = vec![];
    let mut next = f["parent"]["key"].as_str().map(String::from);
    for (level, desc_max) in PARENT_DESC.iter().enumerate() {
        let Some(k) = next.take() else { break };
        let Ok(a) = issue_full(j, &k).await else { break };
        let af = &a["fields"];
        let desc = cut(&text(&af["description"]), *desc_max);
        let mut parts = vec![
            format!(
                "## {} ticket: {} [{} · {}] {}",
                if level == 0 { "Parent" } else { "Grandparent" },
                str_of(&a["key"], &k),
                str_of(&af["issuetype"]["name"], "?"),
                str_of(&af["status"]["name"], "?"),
                str_of(&af["summary"], "")
            ),
            format!("Description:\n{}", if desc.is_empty() { "(empty)" } else { &desc }),
        ];
        let extra = extra_fields(&a, &j.sp_field);
        if !extra.is_empty() {
            parts.push(format!("Fields:\n{}", field_lines(&extra)));
        }
        let all = af["comment"]["comments"].as_array().cloned().unwrap_or_default();
        let cs = last(&all, PARENT_COMMENTS);
        if !cs.is_empty() {
            parts.push(format!("Latest comments:\n{}", comment_lines(cs)));
        }
        out.push(parts.join("\n"));
        next = af["parent"]["key"].as_str().map(String::from);
    }
    out
}

/// The ticket as Jira returns it, and the text Claude gets.
pub async fn collect(j: &Jira, key: &str) -> Result<(Value, String)> {
    let issue = issue_full(j, key).await?;
    let f = &issue["fields"];
    let ikey = str_of(&issue["key"], key).to_string();
    let links = f["issuelinks"].as_array().cloned().unwrap_or_default();
    let link_keys: Vec<&str> = links
        .iter()
        .filter_map(|l| l["outwardIssue"]["key"].as_str().or(l["inwardIssue"]["key"].as_str()))
        .collect();
    let linked_fut = async {
        if link_keys.is_empty() {
            vec![]
        } else {
            search(j, format!("key in ({})", link_keys.join(",")), link_keys.len()).await
        }
    };
    let (linked, children, parents) =
        tokio::join!(linked_fut, search(j, format!("parent = {ikey} ORDER BY key"), CHILDREN), ancestors(j, f));
    let by_key: HashMap<&str, &Value> = linked.iter().filter_map(|i| i["key"].as_str().map(|k| (k, i))).collect();

    let mut out: Vec<String> = vec![format!("# {}: {}", ikey, str_of(&f["summary"], ""))];
    let sp = match if j.sp_field.is_empty() { &Value::Null } else { &f[&j.sp_field] } {
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    let sprint = field_id(&issue, "Sprint").map(|id| join_names(&f[&id], "name")).unwrap_or_default();
    let parent = if f["parent"].is_object() {
        let p = &f["parent"];
        format!("{} {} ({})", str_of(&p["key"], ""), str_of(&p["fields"]["summary"], ""), str_of(&p["fields"]["status"]["name"], "?"))
    } else {
        String::new()
    };
    let labels = f["labels"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "));
    let meta = [
        ("Type", str_of(&f["issuetype"]["name"], "").to_string()),
        ("Status", str_of(&f["status"]["name"], "").to_string()),
        ("Priority", str_of(&f["priority"]["name"], "").to_string()),
        ("Assignee", str_of(&f["assignee"]["displayName"], "Unassigned").to_string()),
        ("Reporter", str_of(&f["reporter"]["displayName"], "").to_string()),
        ("Story points", sp),
        ("Labels", labels.unwrap_or_default()),
        ("Components", join_names(&f["components"], "name")),
        ("Fix versions", join_names(&f["fixVersions"], "name")),
        ("Sprint", sprint),
        ("Parent", parent),
        ("Created", day(&f["created"])),
        ("Updated", day(&f["updated"])),
        ("Due", day(&f["duedate"])),
    ];
    out.push(meta.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("\n"));
    let desc = cut(&text(&f["description"]), DESC);
    out.push(format!("## Description\n{}", if desc.is_empty() { "(empty)" } else { &desc }));

    let extra = extra_fields(&issue, &j.sp_field);
    if !extra.is_empty() {
        out.push(format!("## Other fields\n{}", field_lines(&extra)));
    }
    if let Some(a) = f["attachment"].as_array().filter(|a| !a.is_empty()) {
        let names: Vec<String> = a.iter().filter_map(|x| x["filename"].as_str()).map(|n| format!("- {n}")).collect();
        out.push(format!("## Attachments\n{}", names.join("\n")));
    }
    out.extend(parents);
    if !links.is_empty() {
        let lines: Vec<String> = links
            .iter()
            .map(|l| {
                let (o, kind) = if l["outwardIssue"].is_object() {
                    (&l["outwardIssue"], &l["type"]["outward"])
                } else {
                    (&l["inwardIssue"], &l["type"]["inward"])
                };
                let full = o["key"].as_str().and_then(|k| by_key.get(k).copied());
                format!("- {}: {}{}", str_of(kind, "relates to"), rel(full.unwrap_or(o)), rel_desc(full))
            })
            .collect();
        out.push(format!("## Linked tickets\n{}", lines.join("\n")));
    }
    if !children.is_empty() {
        let lines: Vec<String> = children.iter().map(|c| format!("- {}{}", rel(c), rel_desc(Some(c)))).collect();
        out.push(format!("## Child tickets ({})\n{}", children.len(), lines.join("\n")));
    }
    let all = f["comment"]["comments"].as_array().cloned().unwrap_or_default();
    let comments = last(&all, COMMENTS);
    if !comments.is_empty() {
        let total = f["comment"]["total"].as_u64().unwrap_or(all.len() as u64);
        out.push(format!(
            "## Comments (latest {} of {}, oldest first)\n{}",
            comments.len(),
            total,
            comment_lines(comments)
        ));
    }
    Ok((issue, cut(&out.join("\n\n"), TOTAL)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn adf_to_text() {
        let doc = json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"Hello"},{"type":"text","text":" "},
                {"type":"date","attrs":{"timestamp":"951782400000"}}]},
            {"type":"rule"},{"type":"unknownLeaf","attrs":{}},
            {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]}]}]}
        ]});
        assert_eq!(text(&doc), "Hello 2000-02-29\n- one");
    }

    #[test]
    fn cut_counts_characters() {
        assert_eq!(cut("привет", 10), "привет");
        assert_eq!(cut("привет", 3), format!("при{CUT_MARK}"));
    }

    #[test]
    fn sprint_found_by_name() {
        let issue = json!({ "names": { "customfield_10020": "Sprint", "customfield_1": "Team" } });
        assert_eq!(field_id(&issue, "Sprint").as_deref(), Some("customfield_10020"));
        assert_eq!(field_id(&issue, "Nope"), None);
    }

    #[test]
    fn noise_fields_are_skipped() {
        let issue = json!({
            "fields": { "customfield_1": "{pullrequest={x=1}}", "customfield_2": {"value": "High"},
                        "customfield_3": "AC text", "customfield_9": 5, "customfield_4": [{"name": "S1"}] },
            "names": { "customfield_1": "Development", "customfield_2": "Impact", "customfield_3": "Acceptance",
                       "customfield_9": "Story points", "customfield_4": "Sprint" }
        });
        assert_eq!(
            extra_fields(&issue, "customfield_9"),
            vec![("Acceptance".to_string(), "AC text".to_string()), ("Impact".to_string(), "High".to_string())]
        );
    }
}
