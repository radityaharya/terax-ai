use std::process::{Command, Stdio};
use std::time::Duration;

use super::errors::{classify_probe_output, classify_stderr, AuthHint, SshError};
use super::hosts::SshHost;
use crate::modules::proc::hide_console;

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

pub fn ssh_binary() -> String {
    if cfg!(windows) {
        let system32 = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
            .join("System32")
            .join("OpenSSH")
            .join("ssh.exe");
        if system32.is_file() {
            return system32.to_string_lossy().into_owned();
        }
    }
    "ssh".to_string()
}

fn base_args(host: &SshHost, batch: bool) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        host.port.to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        // Keep idle sessions alive so a quiet host isn't dropped by a NAT/firewall
        // idle timeout (the "lost connection" that used to close the tab). The
        // client sends a probe every 15s and gives up after 4 misses (~60s).
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=4".to_string(),
        "-o".to_string(),
        "TCPKeepAlive=yes".to_string(),
    ];
    if batch {
        args.push("-o".to_string());
        args.push("BatchMode=yes".to_string());
        // Hush the MOTD/banner on non-interactive runs: it pollutes captured
        // stdout (home probing, version checks) and has no user to read it.
        args.push("-q".to_string());
    }
    if let Some(ref key) = host.identity_file {
        args.push("-i".to_string());
        args.push(key.clone());
        args.push("-o".to_string());
        args.push("IdentitiesOnly=yes".to_string());
    }
    if host.agent_forward {
        args.push("-A".to_string());
    }
    args
}

fn target(host: &SshHost) -> String {
    format!("{}@{}", host.user, host.hostname)
}

/// POSIX-shell-quote one argument for the remote command line.
/// `~` stays unquoted: tilde expansion only happens at word starts (exactly
/// where remote paths like `~/.cache/...` need it); mid-word it is literal
/// in POSIX shells, so leaving it bare is safe in both positions. Quoting
/// it would freeze it into a literal `~` directory name.
pub fn shell_quote(arg: &str) -> String {
    if arg.is_empty() {
        return "''".to_string();
    }
    if arg.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':' | '=' | ',' | '~')
    }) {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', "'\\''"))
}

fn run_ssh_capture(host: &SshHost, batch: bool, extra: &[String], timeout: Duration) -> Result<(i32, String, String), String> {
    let mut cmd = Command::new(ssh_binary());
    for arg in base_args(host, batch) {
        cmd.arg(arg);
    }
    // OpenSSH syntax is `ssh [options] [user@]hostname [command]`: the
    // target must precede the remote command, never follow it.
    cmd.arg(target(host));
    // The remote command must be ONE ssh argument. ssh space-joins multiple
    // argv elements before sending, which destroys inner quoting (e.g.
    // `sh -c 'printf %s "$HOME"'` arrives as `sh -c printf %s ...` and the
    // remote shell runs bare `printf` with no format: the classic
    // `%s: 1: printf: usage` failure. Quote each element POSIX-style and
    // join into a single command string.
    if !extra.is_empty() {
        let joined = extra.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ");
        cmd.arg(joined);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("spawn ssh: {e}"))?;
    let out = wait_with_timeout(&mut child, timeout)?;
    let code = out.0;
    Ok((code, out.1, out.2))
}

/// Run a one-shot, non-interactive remote command and capture its output.
/// BatchMode: prompts fail instead of hanging; used for capability probes
/// (e.g. listing zellij sessions) where an absent binary is a valid answer.
pub fn run_remote_capture(
    host: &SshHost,
    extra: &[String],
    timeout: Duration,
) -> Result<(i32, String, String), String> {
    run_ssh_capture(host, true, extra, timeout)
}

fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Result<(i32, String, String), String> {
    use std::io::Read;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut p) = stdout_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut p) = stderr_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    // Back off from 1ms to 25ms: a command that answers immediately is
    // reaped without waiting a fixed 25ms tick, while a long one stops
    // busy-polling. The old flat 25ms sleep taxed every probe on the
    // connect path with up to 25ms of avoidable latency.
    let mut delay = Duration::from_millis(1);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(-1);
                let stdout = stdout_handle.join().unwrap_or_default();
                let stderr = stderr_handle.join().unwrap_or_default();
                return Ok((
                    code,
                    String::from_utf8_lossy(&stdout).into_owned(),
                    String::from_utf8_lossy(&stderr).into_owned(),
                ));
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("ssh command timed out".into());
                }
                std::thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("wait ssh: {e}")),
        }
    }
}

/// Runs a remote command over the multiplexed channel and returns stdout.
/// Used for agent management (version probe). Always BatchMode. Takes the
/// binary and its args separately: joining them into one string would get
/// single-quoted as a whole and the remote would look for a file with
/// spaces in its name.
pub fn run_ssh_capture_version(host: &SshHost, remote_bin: &str) -> Result<String, String> {
    let parts = vec![remote_bin.to_string(), "--version".to_string()];
    match run_ssh_capture(host, true, &parts, DEFAULT_TIMEOUT) {
        Ok((0, stdout, _)) => Ok(stdout.trim().to_string()),
        Ok((_, _, _)) => Ok(String::new()),
        Err(_) => Ok(String::new()),
    }
}

/// Remote shell script that installs an uploaded agent at `remote`.
///
/// Writes to a sibling temp file and `mv -f`s it into place rather than
/// `cat >`-ing the destination directly. Renaming over a file that is
/// currently being executed is allowed on Linux, but opening it for write
/// (what `cat >` does) fails with ETXTBSY. That is precisely the
/// agent-upgrade case: an older `terax-remote serve` may still be running
/// from a previous connection while the new build deploys. The temp file
/// name carries the remote shell's `$$` (PID) so concurrent deploys to the
/// same host cannot collide. `mkdir -p ~/.cache/terax` keeps `~` bare on
/// purpose so the remote shell expands it — quoting would create a literal
/// `~` directory.
fn agent_upload_script(remote: &str) -> String {
    let dest = shell_quote(remote);
    let tmp = format!("{dest}.tmp.$$");
    format!(
        "mkdir -p ~/.cache/terax && cat > {tmp} && chmod +x {tmp} && mv -f {tmp} {dest}"
    )
}

/// Uploads a local file to the remote via stdin redirect, installing it
/// with `agent_upload_script`. No scp dependency; works everywhere system
/// ssh works. Writes in chunks
/// with a liveness check: if ssh exits early (auth failure, remote error)
/// the write fails fast with the remote stderr instead of a bare broken
/// pipe.
pub fn upload_file(host: &SshHost, local: &std::path::Path, remote: &str) -> Result<(), String> {
    let bytes = std::fs::read(local).map_err(|e| format!("read local agent: {e}"))?;
    let script = agent_upload_script(remote);
    let mut cmd = Command::new(ssh_binary());
    for arg in base_args(host, true) {
        cmd.arg(arg);
    }
    cmd.arg(target(host));
    cmd.arg(script);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("spawn ssh upload: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no upload stdin")?;
    use std::io::Write;
    const CHUNK: usize = 64 * 1024;
    let mut wrote = 0;
    for chunk in bytes.chunks(CHUNK) {
        // Fail fast when ssh died mid-upload instead of pushing into a
        // broken pipe (Windows surfaces this as os error 109).
        if let Some(status) = child.try_wait().map_err(|e| format!("upload poll: {e}"))? {
            let mut err = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                use std::io::Read;
                let mut buf = Vec::new();
                let _ = stderr.read_to_end(&mut buf);
                err = String::from_utf8_lossy(&buf).trim().to_string();
            }
            return Err(format!(
                "ssh exited during upload (code {}): {}",
                status.code().unwrap_or(-1),
                if err.is_empty() { "no remote error" } else { &err }
            ));
        }
        stdin
            .write_all(chunk)
            .map_err(|e| format!("upload write at {wrote}/{} bytes: {e}", bytes.len()))?;
        wrote += chunk.len();
    }
    drop(stdin);
    let out = child.wait_with_output().map_err(|e| format!("upload wait: {e}"))?;
    if out.status.success() {
        // Verify the bytes landed intact before declaring success.
        let check = run_ssh_capture(
            host,
            true,
            &["wc".to_string(), "-c".to_string(), remote.to_string()],
            DEFAULT_TIMEOUT,
        )
        .map_err(|e| format!("upload verify: {e}"))?;
        let size: usize = check
            .1
            .split_whitespace()
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        if size != bytes.len() {
            return Err(format!(
                "upload size mismatch: sent {} bytes, remote has {size}",
                bytes.len()
            ));
        }
        Ok(())
    } else {
        Err(format!(
            "agent upload failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Non-interactive probe: `true` on the remote. Success means keys/agent
/// work with no prompts. Failure is classified so the UI can offer the
/// right next step (key file, password, or 2FA terminal).
pub fn probe_auth(host: &SshHost) -> Result<(), SshError> {
    match run_ssh_capture(host, true, &["true".to_string()], PROBE_TIMEOUT) {
        Ok((0, _, _)) => Ok(()),
        Ok((_, _, stderr)) => Err(classify_probe_output(&stderr)),
        Err(_) => Err(SshError::TimedOut {
            message: "ssh connection timed out".into(),
        }),
    }
}

pub fn ssh_home(host: &SshHost) -> Result<String, SshError> {
    let out = run_ssh_capture(
        host,
        true,
        &["sh".to_string(), "-c".to_string(), "printf %s \"$HOME\"".to_string()],
        DEFAULT_TIMEOUT,
    )
    .map_err(|_| SshError::TimedOut {
        message: "ssh connection timed out".into(),
    })?;
    if out.0 != 0 {
        if let Some(err) = classify_stderr(&out.2) {
            return Err(err);
        }
        return Err(SshError::CommandFailed { message: out.2 });
    }
    let home = out
        .1
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    if home.is_empty() {
        return Err(SshError::CommandFailed {
            message: "could not resolve remote home".into(),
        });
    }
    Ok(home)
}

pub fn ssh_login_shell(host: &SshHost) -> Result<String, SshError> {
    const SCRIPT: &str = r#"uid="$(id -u 2>/dev/null || printf '')"
entry=''
if [ -n "$uid" ] && command -v getent >/dev/null 2>&1; then
  entry="$(getent passwd "$uid" 2>/dev/null || true)"
fi
if [ -z "$entry" ] && [ -n "$uid" ] && [ -r /etc/passwd ]; then
  entry="$(awk -F: -v u="$uid" '$3 == u { print; exit }' /etc/passwd 2>/dev/null)"
fi
shell=''
if [ -n "$entry" ]; then
  shell="${entry##*:}"
fi
if [ -z "$shell" ] && [ -n "$SHELL" ]; then
  shell="$SHELL"
fi
if [ -z "$shell" ]; then
  shell=/bin/sh
fi
printf %s "$shell""#;
    let out = run_ssh_capture(
        host,
        true,
        &["sh".to_string(), "-c".to_string(), SCRIPT.to_string()],
        DEFAULT_TIMEOUT,
    )
    .map_err(|_| SshError::TimedOut {
        message: "ssh connection timed out".into(),
    })?;
    if out.0 != 0 {
        if let Some(err) = classify_stderr(&out.2) {
            return Err(err);
        }
        return Err(SshError::CommandFailed { message: out.2 });
    }
    let shell = out
        .1
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("/bin/sh")
        .to_string();
    Ok(shell)
}

/// Remote script that prints the facts the spawn path needs, marker
/// delimited, in a single login. `$HOME`, the login shell, and the installed
/// agent's `--version` token were three separate `ssh` handshakes; on
/// Windows there is no ControlMaster to amortize them, so the connect path
/// paid three full TCP+KEX+auth round trips before it could even start the
/// agent channel. `TERAX_AGENT` is omitted entirely when the agent is not
/// installed, which the parser treats as "needs upload". Every external
/// command is guarded so a bare remote still resolves a home and a shell.
const FACTS_SCRIPT: &str = r#"printf 'TERAX_HOME:%s\n' "$HOME"
uid="$(id -u 2>/dev/null || printf '')"
entry=''
if [ -n "$uid" ] && command -v getent >/dev/null 2>&1; then
  entry="$(getent passwd "$uid" 2>/dev/null || true)"
fi
if [ -z "$entry" ] && [ -n "$uid" ] && [ -r /etc/passwd ]; then
  entry="$(awk -F: -v u="$uid" '$3 == u { print; exit }' /etc/passwd 2>/dev/null)"
fi
shell=''
if [ -n "$entry" ]; then
  shell="${entry##*:}"
fi
if [ -z "$shell" ] && [ -n "$SHELL" ]; then
  shell="$SHELL"
fi
if [ -z "$shell" ]; then
  shell=/bin/sh
fi
printf 'TERAX_SHELL:%s\n' "$shell"
agent="$HOME/.cache/terax/terax-remote"
if [ -x "$agent" ]; then
  printf 'TERAX_AGENT:%s\n' "$("$agent" --version 2>/dev/null || true)"
fi"#;

const HOME_MARKER: &str = "TERAX_HOME:";
const SHELL_MARKER: &str = "TERAX_SHELL:";
const AGENT_MARKER: &str = "TERAX_AGENT:";

/// Facts about a host that one `probe_remote_facts` round trip resolves.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteFacts {
    pub home: String,
    pub login_shell: String,
    /// Raw `terax-remote --version` output; empty when the agent is absent
    /// or older than the marker, which the caller reads as "install it".
    pub agent_version: String,
}

/// Parses marker-delimited `probe_remote_facts` output. Pure so the framing
/// contract is unit-testable without a live host: banners and stray output
/// on stdout are ignored, only prefixed lines count, and the last marker of
/// a kind wins (a chatty remote cannot smuggle a fake value in first).
pub fn parse_remote_facts(stdout: &str) -> RemoteFacts {
    let mut facts = RemoteFacts::default();
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(v) = line.strip_prefix(HOME_MARKER) {
            facts.home = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix(SHELL_MARKER) {
            facts.login_shell = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix(AGENT_MARKER) {
            facts.agent_version = v.trim().to_string();
        }
    }
    facts
}

/// One-shot probe returning home, login shell, and installed agent version
/// over a single ssh handshake. Auth failures classify exactly like
/// `probe_auth` (same stderr), so the UI's next-step hints are unchanged.
pub fn probe_remote_facts(host: &SshHost) -> Result<RemoteFacts, SshError> {
    match run_ssh_capture(
        host,
        true,
        &["sh".to_string(), "-c".to_string(), FACTS_SCRIPT.to_string()],
        PROBE_TIMEOUT,
    ) {
        Ok((0, stdout, _)) => {
            let facts = parse_remote_facts(&stdout);
            if facts.home.is_empty() {
                return Err(SshError::CommandFailed {
                    message: "could not resolve remote home".into(),
                });
            }
            Ok(facts)
        }
        Ok((_, _, stderr)) => Err(classify_probe_output(&stderr)),
        Err(_) => Err(SshError::TimedOut {
            message: "ssh connection timed out".into(),
        }),
    }
}

/// Shared connection args for interactive flows (terminal, master start).
/// Never includes secrets: identity files by path only, passwords only via
/// the PTY prompt or the one-shot askpass helper.
pub fn terminal_base_args(host: &SshHost) -> Vec<String> {
    base_args(host, false)
        .into_iter()
        .filter(|a| a != "BatchMode=yes")
        .collect()
}

/// Args for an interactive terminal session. Passwords and 2FA complete
/// natively in the PTY; Terax never parses those prompts.
pub fn terminal_args(host: &SshHost, remote_shell: Option<&str>) -> Vec<String> {
    let mut args = vec!["-t".to_string()];
    args.extend(terminal_base_args(host));
    args.push(target(host));
    if let Some(shell) = remote_shell.filter(|s| !s.is_empty()) {
        args.push(shell.to_string());
    }
    args
}

/// Args for the agent RPC channel. Always BatchMode: interactive auth only
/// ever happens through the ControlMaster establishment flow. The remote
/// command is passed as ONE ssh argument; splitting it lets word-splitting
/// corrupt paths/args with spaces (same class of bug as run_ssh_capture).
pub fn rpc_args(host: &SshHost, remote_cmd: &str) -> Vec<String> {
    let mut args = base_args(host, true);
    args.push("-T".to_string());
    args.push(target(host));
    // remote_cmd is already a fully-formed local-style command string built
    // by ensure_remote_agent (paths quoted there). Pass through untouched.
    args.push(remote_cmd.to_string());
    args
}

pub fn auth_hint_for_ui(hint: &AuthHint) -> &'static str {
    match hint {
        AuthHint::PublicKeyDenied => "key",
        AuthHint::PasswordRequired => "password",
        AuthHint::KeyboardInteractive => "terminal-2fa",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_script_installs_via_temp_then_rename() {
        let script = agent_upload_script("~/.cache/terax/terax-remote");
        // Never target the live path with `cat >` (ETXTBSY when it is the
        // running agent); write a temp sibling and rename over it.
        assert!(!script.contains("cat > ~/.cache/terax/terax-remote "));
        assert!(script.contains("cat > ~/.cache/terax/terax-remote.tmp.$$"));
        assert!(script.contains("mv -f ~/.cache/terax/terax-remote.tmp.$$ ~/.cache/terax/terax-remote"));
        // `~` must stay bare so the remote shell expands it.
        assert!(!script.contains("'~"));
    }

    #[test]
    fn upload_script_quotes_paths_with_shell_metacharacters() {
        let script = agent_upload_script("/tmp/a b/agent");
        assert!(script.contains("'/tmp/a b/agent'"));
        assert!(script.contains("'/tmp/a b/agent'.tmp.$$"));
    }

    #[test]
    fn parses_all_facts_from_marker_lines() {
        let out = "motd banner\nTERAX_HOME:/home/deploy\nnoise\nTERAX_SHELL:/bin/zsh\nTERAX_AGENT:terax-remote 0.9.0 protocol=3\n";
        let facts = parse_remote_facts(out);
        assert_eq!(facts.home, "/home/deploy");
        assert_eq!(facts.login_shell, "/bin/zsh");
        assert_eq!(facts.agent_version, "terax-remote 0.9.0 protocol=3");
    }

    #[test]
    fn missing_agent_marker_means_install() {
        let facts = parse_remote_facts("TERAX_HOME:/root\nTERAX_SHELL:/bin/bash\n");
        assert_eq!(facts.home, "/root");
        assert_eq!(facts.login_shell, "/bin/bash");
        assert!(facts.agent_version.is_empty());
    }

    #[test]
    fn ignores_unprefixed_output_and_trailing_cr() {
        let out = "HOME:/fake\r\nTERAX_HOME:/real\r\nTERAX_SHELL:/bin/sh\r\n";
        let facts = parse_remote_facts(out);
        assert_eq!(facts.home, "/real");
        assert_eq!(facts.login_shell, "/bin/sh");
    }

    #[test]
    fn last_marker_of_a_kind_wins() {
        let out = "TERAX_HOME:/first\nTERAX_HOME:/second\n";
        assert_eq!(parse_remote_facts(out).home, "/second");
    }
}
