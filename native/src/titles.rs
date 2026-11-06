use serde_json::{Value, json};

pub const PLACEHOLDER: &str = "New conversation";
const FALLBACK_WORDS: usize = 5;
const FALLBACK_BYTES: usize = 40;

// Matches the desktop title service's deterministic fallback: strip terminal and
// invisible controls, collapse whitespace, then bound words and UTF-8 bytes.
pub fn automatic(prompt: &str) -> Option<String> {
    let mut chars = prompt.chars().peekable();
    let mut clean = String::new();
    while let Some(c) = chars.next() {
        let escape = c == '\u{1b}';
        let osc = c == '\u{9d}' || escape && chars.peek() == Some(&']');
        let csi = c == '\u{9b}' || escape && chars.peek() == Some(&'[');
        if osc {
            if escape {
                chars.next();
            }
            while let Some(next) = chars.next() {
                if next == '\u{7}' {
                    break;
                }
                if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                    chars.next();
                    break;
                }
            }
            continue;
        }
        if csi {
            if escape {
                chars.next();
            }
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
            continue;
        }
        if escape {
            if chars.peek().is_some_and(|c| ('@'..='_').contains(c)) {
                chars.next();
            }
            continue;
        }
        if matches!(c,'\u{0}'..='\u{8}'|'\u{b}'|'\u{c}'|'\u{e}'..='\u{1f}'|'\u{7f}'..='\u{9f}'|'\u{200b}'|'\u{200e}'|'\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2060}'..='\u{2064}'|'\u{2066}'..='\u{206f}'|'\u{feff}')
        {
            continue;
        }
        clean.push(c);
    }
    let words = clean
        .split_whitespace()
        .take(FALLBACK_WORDS)
        .collect::<Vec<_>>()
        .join(" ");
    let mut title = String::new();
    for c in words.chars() {
        if title.len() + c.len_utf8() > FALLBACK_BYTES {
            break;
        }
        title.push(c);
    }
    let title = title.trim_end();
    if title.is_empty() {
        None
    } else {
        Some(title.into())
    }
}

pub fn seed(session: &mut Value) {
    if session["automaticName"].is_string() {
        return;
    }
    let title = session["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|m| m["role"] == "user" && m["text"].as_str().is_some_and(|t| !t.trim().is_empty()))
        .and_then(|m| automatic(m["text"].as_str().unwrap()));
    if let Some(title) = title {
        session["automaticName"] = json!(title);
    }
}

pub fn use_automatic(session: &mut Value) {
    seed(session);
    session["nameSource"] = json!("auto");
    session["name"] = session
        .get("automaticName")
        .cloned()
        .unwrap_or(json!(PLACEHOLDER));
}

pub fn migrate(session: &mut Value) -> bool {
    let before = (
        session["name"].clone(),
        session["nameSource"].clone(),
        session["automaticName"].clone(),
    );
    if session.get("nameSource").is_none() {
        let provider = session["provider"].as_str().unwrap_or("");
        let name = session["name"].as_str().unwrap_or("");
        let generic = name == format!("{provider} chat") || name == PLACEHOLDER || name.is_empty();
        session["nameSource"] = json!(if generic { "auto" } else { "manual" });
    }
    seed(session);
    if session["nameSource"] == "auto" {
        use_automatic(session);
    }
    (
        session["name"].clone(),
        session["nameSource"].clone(),
        session["automaticName"].clone(),
    ) != before
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_fallback_is_unicode_and_control_safe() {
        assert_eq!(
            automatic("  Add\nworkspace search and keyboard shortcuts today "),
            Some("Add workspace search and keyboard".into())
        );
        let title = automatic("为左侧栏添加可折叠工具分组并保存用户的排序设置").unwrap();
        assert!(title.len() <= 40);
        assert!(title.starts_with("为左侧栏"));
        assert_eq!(
            automatic("\u{1b}[31mFix\u{1b}[0m \u{202e}workspace\u{2066} search"),
            Some("Fix workspace search".into())
        );
        assert_eq!(
            automatic("\u{1b}]0;hidden\u{7}Visible task"),
            Some("Visible task".into())
        );
        assert_eq!(automatic("\u{200b}\u{202e}"), None);
    }
    #[test]
    fn legacy_default_is_backfilled_but_manual_title_is_preserved() {
        let mut session = json!({"provider":"omp","name":"omp chat","messages":[{"role":"user","text":"Inspect workspace and organize tools"}]});
        assert!(migrate(&mut session));
        assert_eq!(session["name"], "Inspect workspace and organize tools");
        assert!(!migrate(&mut session));
        session["name"] = json!("My release notes");
        session["nameSource"] = json!("manual");
        assert!(!migrate(&mut session));
        session["messages"] = json!([]);
        use_automatic(&mut session);
        assert_eq!(session["name"], "Inspect workspace and organize tools");
    }
}
