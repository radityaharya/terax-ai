//! Zellij multiplexer integration for SSH hosts.
//!
//! Users keep long-running work (dev servers, logs) in detached zellij
//! sessions on remote hosts. Terax lists those sessions over a one-shot
//! `ssh` capture and can open a terminal that reattaches to one. Because
//! the attach runs as the tab's remote command, the reconnect overlay
//! re-runs it verbatim — a dropped tab comes back to the same session.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
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
    /// True for a session kept on disk but not running ("EXITED - attach to
    /// resurrect"). Kill is meaningless for these; delete is the real action.
    pub exited: bool,
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

/// `zellij attach <session>` as an argv vector. `bin` is the resolved
/// absolute path (`zellij_binary`) so the attach matches the list probe; the
/// caller POSIX-quotes each element into the single remote command argument.
pub fn build_attach_argv(bin: &str, session: &str) -> Result<Vec<String>, String> {
    let session = session.trim();
    validate_session_name(session)?;
    Ok(vec![bin.to_string(), "attach".to_string(), session.to_string()])
}

/// Prints the absolute path of `zellij`, or nothing.
///
/// A one-shot ssh command runs the login shell *non-interactively*, which for
/// zsh reads only `.zshenv`. Per-user installers — cargo, pipx, and Linuxbrew
/// in particular — usually export PATH from an *interactive* rc (`.zshrc`)
/// that never runs here, so `zellij` reads as uninstalled even though the
/// user's own terminal finds it fine. Sourcing those rc files is not an
/// option: they can block on prompts (an interactive `zsh -ic` on a real host
/// hung past 90s). So ask the shell first and fall back to the well-known
/// install locations directly. No single quotes anywhere, so the whole script
/// survives `shell_quote` as one clean argument.
const RESOLVE_SCRIPT: &str = r#"p="$(command -v zellij 2>/dev/null || true)"
if [ -n "$p" ] && [ -x "$p" ]; then printf "%s\n" "$p"; exit 0; fi
for c in "$HOME/.cargo/bin/zellij" "$HOME/.local/bin/zellij" "$HOME/.linuxbrew/bin/zellij" "/home/linuxbrew/.linuxbrew/bin/zellij" "/opt/homebrew/bin/zellij" "/usr/local/bin/zellij" "/usr/bin/zellij"; do
  if [ -x "$c" ]; then printf "%s\n" "$c"; exit 0; fi
done
exit 127"#;

/// Pick the resolved path out of the script's stdout. Requiring an absolute
/// path ending in `/zellij` means a login banner or shell warning on stdout
/// can never be mistaken for a binary.
fn parse_resolved_path(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('/') && l.ends_with("/zellij"))
        .last()
        .map(str::to_string)
}

/// Resolved paths are per-host and change only when the user installs or
/// removes zellij, so cache the successes. Misses are never cached: a fresh
/// install must be picked up on the next refresh.
fn binary_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn forget_binary(host_id: &str) {
    if let Ok(mut cache) = binary_cache().lock() {
        cache.remove(host_id);
    }
}

/// The zellij emplacement to invoke on this host: an absolute path when it can
/// be found, else the bare name so the caller still gets a meaningful
/// "not installed" answer instead of silently failing.
pub fn zellij_binary(host: &SshHost) -> String {
    if let Ok(cache) = binary_cache().lock() {
        if let Some(hit) = cache.get(&host.id) {
            return hit.clone();
        }
    }
    let extra = vec![
        "sh".to_string(),
        "-c".to_string(),
        RESOLVE_SCRIPT.to_string(),
    ];
    let resolved = match run_remote_capture(host, &extra, LIST_TIMEOUT) {
        Ok((0, stdout, _)) => parse_resolved_path(&stdout),
        _ => None,
    };
    match resolved {
        Some(path) => {
            if let Ok(mut cache) = binary_cache().lock() {
                cache.insert(host.id.clone(), path.clone());
            }
            path
        }
        None => "zellij".to_string(),
    }
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
        // `(EXITED - attach to resurrect)` marks a stopped-but-resurrectable
        // session; `--short` drops the annotation, which reads as running.
        let exited = lower.contains("exited");
        out.push(ZellijSession {
            name: name.to_string(),
            exited,
        });
    }
    out
}

/// Command that mutates rather than observes: same capture discipline, but a
/// non-zero exit is an error the UI shows instead of an empty result.
const MUTATE_TIMEOUT: Duration = Duration::from_secs(20);

fn session_arg(session: &str) -> Result<String, String> {
    let session = session.trim();
    validate_session_name(session)?;
    Ok(session.to_string())
}

/// `--session <from> action rename-session <to>`. The global `--session` flag
/// is how a rename is aimed at *another* session; `action` alone acts on the
/// session it was invoked from.
pub fn build_rename_argv(bin: &str, from: &str, to: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        bin.to_string(),
        "--session".to_string(),
        session_arg(from)?,
        "action".to_string(),
        "rename-session".to_string(),
        session_arg(to)?,
    ])
}

/// Stop a running session but keep it on disk for `attach` to resurrect.
pub fn build_kill_argv(bin: &str, session: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        bin.to_string(),
        "kill-session".to_string(),
        session_arg(session)?,
    ])
}

/// Remove a session for good. `--force` kills it first when it is running and
/// implies consent, so the capture never blocks on a prompt.
pub fn build_delete_argv(bin: &str, session: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        bin.to_string(),
        "delete-session".to_string(),
        "--force".to_string(),
        session_arg(session)?,
    ])
}

/// `--yes` is mandatory: both bulk commands prompt otherwise, and a
/// non-interactive capture has nothing to answer with.
pub fn build_kill_all_argv(bin: &str) -> Vec<String> {
    vec![
        bin.to_string(),
        "kill-all-sessions".to_string(),
        "--yes".to_string(),
    ]
}

pub fn build_delete_all_argv(bin: &str) -> Vec<String> {
    vec![
        bin.to_string(),
        "delete-all-sessions".to_string(),
        "--force".to_string(),
        "--yes".to_string(),
    ]
}

/// Run a mutating zellij command, surfacing the remote's own message on
/// failure (e.g. "Session: \"x\" not found.").
fn run_mutation(host: &SshHost, argv: Vec<String>) -> Result<(), String> {
    let (code, stdout, stderr) = run_remote_capture(host, &argv, MUTATE_TIMEOUT)?;
    if code == 0 {
        return Ok(());
    }
    let detail = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or("no output")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .unwrap_or("no output")
        .trim()
        .to_string();
    Err(format!("zellij failed (exit {code}): {detail}"))
}

pub fn rename_session(host: &SshHost, from: &str, to: &str) -> Result<(), String> {
    let argv = build_rename_argv(&zellij_binary(host), from, to)?;
    run_mutation(host, argv)
}

pub fn kill_session(host: &SshHost, session: &str) -> Result<(), String> {
    let argv = build_kill_argv(&zellij_binary(host), session)?;
    run_mutation(host, argv)
}

pub fn delete_session(host: &SshHost, session: &str) -> Result<(), String> {
    let argv = build_delete_argv(&zellij_binary(host), session)?;
    run_mutation(host, argv)
}

pub fn kill_all_sessions(host: &SshHost) -> Result<(), String> {
    let argv = build_kill_all_argv(&zellij_binary(host));
    run_mutation(host, argv)
}

pub fn delete_all_sessions(host: &SshHost) -> Result<(), String> {
    let argv = build_delete_all_argv(&zellij_binary(host));
    run_mutation(host, argv)
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
fn list_attempts(bin: &str) -> [Vec<String>; 3] {
    let argv = |rest: &[&str]| {
        std::iter::once(bin.to_string())
            .chain(rest.iter().map(|s| (*s).to_string()))
            .collect::<Vec<String>>()
    };
    [
        argv(&["list-sessions", "--no-formatting", "--short"]),
        argv(&["list-sessions", "--no-formatting"]),
        argv(&["list-sessions"]),
    ]
}

pub fn list_sessions(host: &SshHost) -> Result<ZellijSessions, String> {
    let bin = zellij_binary(host);
    let mut last_error: Option<String> = None;
    for extra in list_attempts(&bin) {
        let (code, stdout, stderr) = run_remote_capture(host, &extra, LIST_TIMEOUT)?;
        if looks_missing(code, &stderr) {
            // The cached path may have gone stale (zellij uninstalled or
            // moved): drop it so the next refresh re-resolves.
            forget_binary(&host.id);
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
                ZellijSession {
                    name: "alpha".into(),
                    exited: false
                },
                ZellijSession {
                    name: "beta".into(),
                    exited: false
                }
            ]
        );
    }

    #[test]
    fn marks_exited_sessions() {
        let out = "running [Created 2s ago] \nexited-one [Created 2m ago] (EXITED - attach to resurrect)\n";
        let sessions = parse_sessions(out);
        assert_eq!(sessions.len(), 2);
        assert!(!sessions[0].exited, "plain session reads as running");
        assert!(sessions[1].exited, "EXITED annotation is captured");
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
            build_attach_argv("zellij", "dev").unwrap(),
            vec!["zellij".to_string(), "attach".to_string(), "dev".to_string()]
        );
        assert!(build_attach_argv("zellij", "-x").is_err());
    }

    #[test]
    fn attach_argv_uses_the_resolved_binary() {
        assert_eq!(
            build_attach_argv("/home/linuxbrew/.linuxbrew/bin/zellij", "dev").unwrap(),
            vec![
                "/home/linuxbrew/.linuxbrew/bin/zellij".to_string(),
                "attach".to_string(),
                "dev".to_string()
            ]
        );
    }

    #[test]
    fn resolves_absolute_paths_and_ignores_banner_noise() {
        assert_eq!(
            parse_resolved_path("/home/linuxbrew/.linuxbrew/bin/zellij\n").as_deref(),
            Some("/home/linuxbrew/.linuxbrew/bin/zellij")
        );
        // A login banner on stdout must never be mistaken for the binary.
        let noisy = "WARNING: Authorized Access Only\n****\n/usr/local/bin/zellij\n";
        assert_eq!(
            parse_resolved_path(noisy).as_deref(),
            Some("/usr/local/bin/zellij")
        );
    }

    #[test]
    fn parse_resolved_path_rejects_non_binary_output() {
        assert_eq!(parse_resolved_path(""), None);
        assert_eq!(parse_resolved_path("zellij\n"), None);
        assert_eq!(parse_resolved_path("/usr/bin/other\n"), None);
        assert_eq!(parse_resolved_path("command not found\n"), None);
    }

    #[test]
    fn rename_targets_the_session_through_the_global_flag() {
        assert_eq!(
            build_rename_argv("zellij", "old", "new").unwrap(),
            vec![
                "zellij",
                "--session",
                "old",
                "action",
                "rename-session",
                "new"
            ]
        );
    }

    #[test]
    fn mutations_quote_neither_and_reject_bad_names() {
        assert!(build_rename_argv("zellij", "a;b", "ok").is_err());
        assert!(build_rename_argv("zellij", "ok", "-x").is_err());
        assert!(build_kill_argv("zellij", "$(rm -rf /)").is_err());
        assert!(build_delete_argv("zellij", "a b").is_err());
    }

    #[test]
    fn kill_keeps_the_session_and_delete_forces() {
        assert_eq!(
            build_kill_argv("/usr/bin/zellij", "dev").unwrap(),
            vec!["/usr/bin/zellij", "kill-session", "dev"]
        );
        assert_eq!(
            build_delete_argv("/usr/bin/zellij", "dev").unwrap(),
            vec!["/usr/bin/zellij", "delete-session", "--force", "dev"]
        );
    }

    #[test]
    fn bulk_commands_never_prompt() {
        assert_eq!(
            build_kill_all_argv("zellij"),
            vec!["zellij", "kill-all-sessions", "--yes"]
        );
        assert_eq!(
            build_delete_all_argv("zellij"),
            vec!["zellij", "delete-all-sessions", "--force", "--yes"]
        );
    }

    #[test]
    fn list_attempts_use_the_resolved_binary_and_keep_fallbacks() {
        let attempts = list_attempts("/opt/homebrew/bin/zellij");
        assert_eq!(attempts.len(), 3);
        for a in &attempts {
            assert_eq!(a[0], "/opt/homebrew/bin/zellij");
            assert_eq!(a[1], "list-sessions");
        }
        assert_eq!(attempts[0].last().unwrap(), "--short");
        // The last resort must stay bare so old builds without the richer
        // flags are still parsed.
        assert_eq!(attempts[2].len(), 2);
    }
}
