use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
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

fn run_ssh_capture(host: &SshHost, batch: bool, extra: &[String], timeout: Duration) -> Result<(i32, String, String), String> {
    let mut cmd = Command::new(ssh_binary());
    for arg in base_args(host, batch) {
        cmd.arg(arg);
    }
    // OpenSSH syntax is `ssh [options] [user@]hostname [command]`: the
    // target must precede the remote command, never follow it.
    cmd.arg(target(host));
    for arg in extra {
        cmd.arg(arg);
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
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("wait ssh: {e}")),
        }
    }
}

/// Runs a remote command over the multiplexed channel and returns stdout.
/// Used for agent management (version probe). Always BatchMode.
pub fn run_ssh_capture_version(host: &SshHost, remote_cmd: &str) -> Result<String, String> {
    let parts: Vec<String> = vec![remote_cmd.to_string()];
    match run_ssh_capture(host, true, &parts, DEFAULT_TIMEOUT) {
        Ok((0, stdout, _)) => Ok(stdout.trim().to_string()),
        Ok((_, _, _)) => Ok(String::new()),
        Err(_) => Ok(String::new()),
    }
}

/// Uploads a local file to the remote via stdin redirect:
/// `ssh host 'mkdir -p ~/.cache/terax && cat > <remote> && chmod +x <remote>'`.
/// No scp dependency; works everywhere system ssh works.
pub fn upload_file(host: &SshHost, local: &std::path::Path, remote: &str) -> Result<(), String> {
    let bytes = std::fs::read(local).map_err(|e| format!("read local agent: {e}"))?;
    let script = format!("mkdir -p ~/.cache/terax && cat > {remote} && chmod +x {remote}");
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
    stdin.write_all(&bytes).map_err(|e| format!("upload write: {e}"))?;
    drop(stdin);
    let out = child.wait_with_output().map_err(|e| format!("upload wait: {e}"))?;
    if out.status.success() {
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
/// ever happens through the ControlMaster establishment flow.
pub fn rpc_args(host: &SshHost, remote_cmd: &str) -> Vec<String> {
    let mut args = base_args(host, true);
    args.push("-T".to_string());
    args.push(target(host));
    args.push(remote_cmd.to_string());
    args
}

pub fn master_socket_path(host_id: &str) -> Result<std::path::PathBuf, SshError> {
    super::hosts::validate_host_id(host_id).map_err(|m| SshError::UnsafeHost { message: m })?;
    let dir = dirs::cache_dir()
        .ok_or_else(|| SshError::Io {
            message: "could not resolve cache directory".into(),
        })?
        .join("terax")
        .join("ssh-masters");
    std::fs::create_dir_all(&dir).map_err(|e| SshError::Io {
        message: format!("create master dir: {e}"),
    })?;
    Ok(dir.join(format!("master-{host_id}")))
}

pub struct MasterRegistry {
    live: Mutex<HashMap<String, bool>>,
}

impl Default for MasterRegistry {
    fn default() -> Self {
        Self {
            live: Mutex::new(HashMap::new()),
        }
    }
}

impl MasterRegistry {
    pub fn mark_live(&self, host_id: &str) {
        self.live.lock().unwrap().insert(host_id.to_string(), true);
    }

    pub fn mark_dead(&self, host_id: &str) {
        self.live.lock().unwrap().remove(host_id);
    }

    pub fn is_live_cached(&self, host_id: &str) -> bool {
        self.live.lock().unwrap().contains_key(host_id)
    }
}

pub struct ProbeCache {
    entries: Mutex<HashMap<String, (bool, std::time::Instant)>>,
}

impl Default for ProbeCache {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl ProbeCache {
    pub fn get(&self, host_id: &str) -> Option<bool> {
        let mut map = self.entries.lock().unwrap();
        let (ok, at) = map.get(host_id)?;
        if at.elapsed() < Duration::from_secs(60) {
            Some(*ok)
        } else {
            map.remove(host_id);
            None
        }
    }

    pub fn set(&self, host_id: &str, ok: bool) {
        self.entries
            .lock()
            .unwrap()
            .insert(host_id.to_string(), (ok, std::time::Instant::now()));
    }
}

pub fn auth_hint_for_ui(hint: &AuthHint) -> &'static str {
    match hint {
        AuthHint::PublicKeyDenied => "key",
        AuthHint::PasswordRequired => "password",
        AuthHint::KeyboardInteractive => "terminal-2fa",
    }
}

pub struct SessionDeps {
    pub masters: Arc<MasterRegistry>,
    pub probes: Arc<ProbeCache>,
}

impl Default for SessionDeps {
    fn default() -> Self {
        Self {
            masters: Arc::new(MasterRegistry::default()),
            probes: Arc::new(ProbeCache::default()),
        }
    }
}
