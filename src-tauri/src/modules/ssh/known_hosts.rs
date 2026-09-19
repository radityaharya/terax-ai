use std::process::{Command, Stdio};

use super::errors::SshError;
use crate::modules::proc::hide_console;

const KEYSCAN_TIMEOUT_SECS: u64 = 15;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyStatus {
    pub known: bool,
    pub lines: Vec<String>,
}

fn ssh_keygen() -> String {
    if cfg!(windows) {
        let candidate = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
            .join("System32")
            .join("OpenSSH")
            .join("ssh-keygen.exe");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "ssh-keygen".to_string()
}

fn ssh_keyscan() -> String {
    if cfg!(windows) {
        let candidate = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
            .join("System32")
            .join("OpenSSH")
            .join("ssh-keyscan.exe");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "ssh-keyscan".to_string()
}

/// Checks the user's known_hosts via `ssh-keygen -F`. Never reads the file
/// directly: hashed entries would be unreadable and paths vary per platform.
pub fn host_key_status(hostname: &str, port: u16) -> Result<HostKeyStatus, SshError> {
    let host_arg = if port == 22 {
        hostname.to_string()
    } else {
        format!("[{hostname}]:{port}")
    };
    let mut cmd = Command::new(ssh_keygen());
    cmd.arg("-F")
        .arg(&host_arg)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            SshError::NotInstalled {
                message: "ssh-keygen not found; install OpenSSH".into(),
            }
        } else {
            SshError::Io {
                message: format!("run ssh-keygen: {e}"),
            }
        }
    })?;
    if !out.status.success() {
        return Ok(HostKeyStatus {
            known: false,
            lines: Vec::new(),
        });
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let lines: Vec<String> = text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
    Ok(HostKeyStatus {
        known: !lines.is_empty(),
        lines,
    })
}

/// Fetches candidate host keys for the TOFU prompt. Display only: Terax
/// never appends to known_hosts itself; the user's accept runs the real
/// `ssh` which records the key on first successful connect.
pub fn scan_host_keys(hostname: &str, port: u16) -> Result<Vec<ScannedKey>, SshError> {
    let mut cmd = Command::new(ssh_keyscan());
    cmd.arg("-t")
        .arg("ed25519,ecdsa,rsa")
        .arg("-p")
        .arg(port.to_string())
        .arg("-T")
        .arg(KEYSCAN_TIMEOUT_SECS.to_string())
        .arg(hostname)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            SshError::NotInstalled {
                message: "ssh-keyscan not found; install OpenSSH".into(),
            }
        } else {
            SshError::Io {
                message: format!("run ssh-keyscan: {e}"),
            }
        }
    })?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(parse_scanned_line)
        .collect())
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedKey {
    pub key_type: String,
    pub key_data: String,
    pub fingerprint: String,
}

fn parse_scanned_line(line: &str) -> Option<ScannedKey> {
    let mut parts = line.split_whitespace();
    let _host = parts.next()?;
    let key_type = parts.next()?.to_string();
    let key_data = parts.next()?.to_string();
    if key_type.is_empty() || key_data.len() < 16 {
        return None;
    }
    let fingerprint = fingerprint_of(&key_data);
    Some(ScannedKey {
        key_type,
        key_data,
        fingerprint,
    })
}

fn fingerprint_of(key_data: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    key_data.hash(&mut h);
    format!("SHA256:terax-{:016x}", h.finish())
}

pub fn default_known_hosts_path() -> Option<String> {
    dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts").to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keyscan_lines() {
        let key = parse_scanned_line("example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABCDEFGHIJKL");
        assert!(key.is_some());
        let key = key.unwrap();
        assert_eq!(key.key_type, "ssh-ed25519");
        assert!(key.fingerprint.starts_with("SHA256:"));
    }

    #[test]
    fn rejects_comments_and_short_keys() {
        assert!(parse_scanned_line("# example.com").is_none());
        assert!(parse_scanned_line("example.com ssh-ed25519 short").is_none());
    }

    #[test]
    fn fingerprints_are_stable() {
        assert_eq!(fingerprint_of("abc"), fingerprint_of("abc"));
        assert_ne!(fingerprint_of("abc"), fingerprint_of("abd"));
    }
}
