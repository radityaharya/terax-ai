//! Zellij multiplexer integration for SSH hosts.
//!
//! Users keep long-running work (dev servers, logs) in detached zellij
//! sessions on remote hosts. Terax lists those sessions over a one-shot
//! `ssh` capture and can open a terminal that reattaches to one. Because
//! the attach runs as the tab's remote command, the reconnect overlay
//! re-runs it verbatim — a dropped tab comes back to the same session.

use serde::Serialize;
use std::time::Duration;

use super::hosts::SshHost;
use super::session::run_remote_capture;

/// `zellij list-sessions` is a metadata call: fail fast rather than hang a
/// sidebar behind a wedged connection.
const LIST_TIMEOUT: Duration = Duration::from_secs(10);

/// Zellij session names are short identifiers; bound them to keep a
/// hostile or corrupt list output from producing an absurd remote argv.
const MAX_SESSION_NAME: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZellijSession {
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZellijSessions {
    /// False when the `zellij` binary is absent on the remote. The UI shows
    /// an install hint instead of an empty list.
    pub available: bool,
    pub sessions: Vec<ZellijSession>,
}

/// A session name is passed to `zellij attach` as an argv element. Reject
/// anything that could be read as a flag (`-`/`--`) or smuggle shell
/// metacharacters once the remote command string is assembled.
pub fn validate_session_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("session name is empty".into());
    }
    if name.len() > MAX_SESSION_NAME {
        return Err(format!("session name too long: {} bytes", name.len()));
    }
    let mut chars = name.chars();
    let first = chars.next().expect("non-empty");
    if !first.is_ascii_alphanumeric() {
        return Err(format!("invalid zellij session name: {name}"));
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        return Err(format!("invalid zellij session name: {name}"));
    }
    Ok(())
}

/// `zellij attach <session>` as an argv vector. The caller POSIX-quotes
/// each element into the single remote command argument.
pub fn build_attach_argv(session: &str) -> Result<Vec<String>, String> {
    let session = session.trim();
    validate_session_name(session)?;
    Ok(vec!["zellij".to_string(), "attach".to_string(), session.to_string()])
}

/// Strip CSI escape sequences (SGR colors and friends) so plain, still
/// colorized `list-sessions` output parses cleanly.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                // Consume until a final byte in the @-~ range.
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            // Bare ESC or OSC: drop the ESC and continue.
            _ => {}
        }
    }
    out
}

/// Parse `zellij list-sessions` output. Handles `--short` (bare names),
/// `--no-formatting`, and the default decorated form:
///
/// ```text
/// mine [Created 12m ago] (current)
/// other [Created 3h ago]
/// No active zellij sessions found.
/// ```
///
/// Only the leading token is meaningful: zellij names are single words.
pub fn parse_sessions(stdout: &str) -> Vec<ZellijSession> {
    let mut out: Vec<ZellijSession> = Vec::new();
    for raw in stdout.lines() {
        let line = strip_ansi(raw);
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("no active") || lower.starts_with("no sessions") {
            continue;
        }
        let name = line.split_whitespace().next().unwrap_or("");
        if name.is_empty() || validate_session_name(name).is_err() {
            continue;
        }
        if out.iter().any(|s| s.name == name) {
            continue;
        }
        out.push(ZellijSession { name: name.to_string() });
    }
    out
}

fn looks_missing(code: i32, stderr: &str) -> bool {
    if code == 127 {
        return true;
    }
    let s = stderr.to_ascii_lowercase();
    s.contains("command not found") || s.contains("zellij: not found")
}

fn says_no_sessions(stdout: &str, stderr: &str) -> bool {
    let hay = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    hay.contains("no active") || hay.contains("no sessions") || hay.contains("no zellij sessions")
}

fn looks_unknown_option(stdout: &str, stderr: &str) -> bool {
    let hay = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    hay.contains("unexpected argument")
        || hay.contains("unrecognized")
        || hay.contains("unknown flag")
        || hay.contains("unknown option")
}

/// Older zellij builds lack `--short` / `--no-formatting`; try the richest
/// output first and fall back until one is accepted.
fn list_attempts() -> [&'static [&'static str]; 3] {
    [
        &["zellij", "list-sessions", "--no-formatting", "--short"],
        &["zellij", "list-sessions", "--no-formatting"],
        &["zellij", "list-sessions"],
    ]
}

pub fn list_sessions(host: &SshHost) -> Result<ZellijSessions, String> {
    let mut last_error: Option<String> = None;
    for attempt in list_attempts() {
        let extra: Vec<String> = attempt.iter().map(|s| (*s).to_string()).collect();
        let (code, stdout, stderr) = run_remote_capture(host, &extra, LIST_TIMEOUT)?;
        if looks_missing(code, &stderr) {
            return Ok(ZellijSessions {
                available: false,
                sessions: Vec::new(),
            });
        }
        if says_no_sessions(&stdout, &stderr) {
            return Ok(ZellijSessions {
                available: true,
                sessions: Vec::new(),
            });
        }
        if code == 0 {
            return Ok(ZellijSessions {
                available: true,
                sessions: parse_sessions(&stdout),
            });
        }
        if !looks_unknown_option(&stdout, &stderr) {
            let detail = stderr.trim();
            let detail = if detail.is_empty() { stdout.trim() } else { detail };
            let detail = detail.lines().next().unwrap_or("").trim();
            return Err(format!("zellij list-sessions failed (exit {code}): {detail}"));
        }
        last_error = Some(format!("exit {code}: {}", stderr.trim()));
    }
    Err(last_error.unwrap_or_else(|| "zellij list-sessions failed".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_short_names() {
        let sessions = parse_sessions("alpha\nbeta\n");
        assert_eq!(
            sessions,
            vec![
                ZellijSession { name: "alpha".into() },
                ZellijSession { name: "beta".into() }
            ]
        );
    }

    #[test]
    fn parses_decorated_and_no_formatting_output() {
        let out = "mine [Created 12m ago] (current)\nother [Created 3h ago]\n";
        let sessions = parse_sessions(out);
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].name, "mine");
        assert_eq!(sessions[1].name, "other");
    }

    #[test]
    fn ignores_empty_and_no_sessions_messages() {
        assert!(parse_sessions("").is_empty());
        assert!(parse_sessions("No active zellij sessions found.\n").is_empty());
        assert!(parse_sessions("\n\n").is_empty());
    }

    #[test]
    fn dedupes_and_strips_ansi() {
        let out = "\u{1b}[32mdup\u{1b}[0m\ndup\ndup [Created 1m ago]\n";
        let sessions = parse_sessions(out);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "dup");
    }

    #[test]
    fn rejects_flag_like_and_metacharacter_names() {
        assert!(validate_session_name("-s").is_err());
        assert!(validate_session_name("--create").is_err());
        assert!(validate_session_name("a b").is_err());
        assert!(validate_session_name("a;rm -rf /").is_err());
        assert!(validate_session_name("").is_err());
        assert!(validate_session_name(&"x".repeat(MAX_SESSION_NAME + 1)).is_err());
        assert!(validate_session_name("dev.web_1-2").is_ok());
    }

    #[test]
    fn attach_argv_is_zellij_attach() {
        assert_eq!(
            build_attach_argv("dev").unwrap(),
            vec!["zellij".to_string(), "attach".to_string(), "dev".to_string()]
        );
        assert!(build_attach_argv("-x").is_err());
    }
}
