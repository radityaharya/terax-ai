use serde_json::json;

use super::hosts::{host_store, SshHost};
use super::rpc::SshRpcManager;

#[cfg(not(windows))]
const ZSHENV_SCRIPT: &str = include_str!("../pty/scripts/zshenv.zsh");
#[cfg(not(windows))]
const ZPROFILE_SCRIPT: &str = include_str!("../pty/scripts/zprofile.zsh");
#[cfg(not(windows))]
const ZLOGIN_SCRIPT: &str = include_str!("../pty/scripts/zlogin.zsh");
#[cfg(not(windows))]
const ZSHRC_SCRIPT: &str = include_str!("../pty/scripts/zshrc.zsh");
#[cfg(not(windows))]
const BASHRC_SCRIPT: &str = include_str!("../pty/scripts/bashrc.bash");
#[cfg(not(windows))]
const FISH_INIT_SCRIPT: &str = include_str!("../pty/scripts/init.fish");

#[cfg(windows)]
const ZSHENV_SCRIPT: &str = include_str!("../pty/scripts/zshenv.zsh");
#[cfg(windows)]
const ZPROFILE_SCRIPT: &str = include_str!("../pty/scripts/zprofile.zsh");
#[cfg(windows)]
const ZLOGIN_SCRIPT: &str = include_str!("../pty/scripts/zlogin.zsh");
#[cfg(windows)]
const ZSHRC_SCRIPT: &str = include_str!("../pty/scripts/zshrc.zsh");
#[cfg(windows)]
const BASHRC_SCRIPT: &str = include_str!("../pty/scripts/bashrc.bash");
#[cfg(windows)]
const FISH_INIT_SCRIPT: &str = include_str!("../pty/scripts/init.fish");

pub const FISH_REINSTALL_PROMPT: &str =
    "functions -q __terax_install_prompt; and __terax_install_prompt";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShellKind {
    Zsh,
    Bash,
    Fish,
    Other,
}

impl ShellKind {
    pub fn classify(path: &str) -> Self {
        match path.rsplit('/').next().unwrap_or("") {
            "zsh" => ShellKind::Zsh,
            "bash" => ShellKind::Bash,
            "fish" => ShellKind::Fish,
            _ => ShellKind::Other,
        }
    }
}

#[derive(Clone, Debug)]
pub enum SshIntegration {
    Zsh { zdotdir: String },
    Bash { rcfile: String },
    Fish,
    None,
}

/// Spawn-time entry point: resolves the host, ensures the agent, probes the
/// login shell and remote home, installs integration scripts, and returns
/// the launch wiring. Fully best-effort: any failure degrades to
/// `SshIntegration::None` (bare shell) with a warning, never a spawn error.
pub fn ensure_remote_integration_for_spawn(
    app: &tauri::AppHandle,
    ssh: &super::SshShared,
    host_id: &str,
) -> SshIntegration {
    match ensure_inner(app, ssh, host_id) {
        Ok(integration) => integration,
        Err(e) => {
            log::warn!("ssh shell integration unavailable for {host_id}: {e}");
            SshIntegration::None
        }
    }
}

fn ensure_inner(
    app: &tauri::AppHandle,
    ssh: &super::SshShared,
    host_id: &str,
) -> Result<SshIntegration, String> {
    let store = host_store();
    store.load(app);
    let host = store
        .get(host_id)
        .ok_or_else(|| format!("unknown SSH host: {host_id}"))?;
    let remote_bin = super::commands::ensure_remote_agent(&host)?;
    let remote_root = match host.remote_root.clone().filter(|r| !r.is_empty()) {
        Some(root) => root,
        None => super::session::ssh_home(&host).map_err(|e| e.to_string())?,
    };
    let shell_path = super::session::ssh_login_shell(&host).map_err(|e| e.to_string())?;
    Ok(ensure_remote_integration(
        &ssh.rpc,
        host_id,
        &host,
        &remote_bin,
        &remote_root,
        &shell_path,
    ))
}

/// Installs the Terax shell-integration scripts on the remote host via the
/// agent RPC channel (fs_create_dir + fs_write_file) and returns the launch
/// wiring for the detected login shell. Best-effort: any failure degrades
/// to `None` (bare shell) with a warning, never a spawn failure.
pub fn ensure_remote_integration(
    rpc: &SshRpcManager,
    host_id: &str,
    host: &SshHost,
    remote_bin: &str,
    remote_root: &str,
    shell_path: &str,
) -> SshIntegration {
    let kind = ShellKind::classify(shell_path);
    if matches!(kind, ShellKind::Other) {
        return SshIntegration::None;
    }
    let base = format!("{}/.cache/terax/shell-integration", remote_root.trim_end_matches('/'));
    let write = |rel: &str, content: &str| -> Result<(), String> {
        rpc.request(
            host_id,
            "fs_create_dir",
            json!({ "path": format!("{base}/{}", dir_of(rel)) }),
            remote_bin,
            remote_root,
        )?;
        rpc.request(
            host_id,
            "fs_write_file",
            json!({ "path": format!("{base}/{rel}"), "content": content }),
            remote_bin,
            remote_root,
        )?;
        Ok(())
    };
    let result = match kind {
        ShellKind::Zsh => {
            write("zsh/.zshenv", &unix_newlines(ZSHENV_SCRIPT))
                .and_then(|_| write("zsh/.zprofile", &unix_newlines(ZPROFILE_SCRIPT)))
                .and_then(|_| write("zsh/.zshrc", &unix_newlines(ZSHRC_SCRIPT)))
                .and_then(|_| write("zsh/.zlogin", &unix_newlines(ZLOGIN_SCRIPT)))
                .map(|_| SshIntegration::Zsh {
                    zdotdir: format!("{base}/zsh"),
                })
        }
        ShellKind::Bash => write("bash/bashrc", &unix_newlines(BASHRC_SCRIPT)).map(|_| {
            SshIntegration::Bash {
                rcfile: format!("{base}/bash/bashrc"),
            }
        }),
        ShellKind::Fish => {
            // Fish reads conf.d from the real home; install there, not cache.
            let home = remote_root.trim_end_matches('/');
            let conf = format!("{home}/.config/fish/conf.d");
            rpc.request(
                host_id,
                "fs_create_dir",
                json!({ "path": conf }),
                remote_bin,
                remote_root,
            )
            .and_then(|_| {
                rpc.request(
                    host_id,
                    "fs_write_file",
                    json!({
                        "path": format!("{conf}/terax.fish"),
                        "content": unix_newlines(FISH_INIT_SCRIPT),
                    }),
                    remote_bin,
                    remote_root,
                )
            })
            .map(|_| SshIntegration::Fish)
        }
        ShellKind::Other => Ok(SshIntegration::None),
    };
    match result {
        Ok(integration) => {
            log::info!("ssh shell integration ready for {} ({shell_path})", host.hostname);
            integration
        }
        Err(e) => {
            log::warn!("ssh shell integration disabled for {}: {e}", host.hostname);
            SshIntegration::None
        }
    }
}

fn dir_of(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn unix_newlines(content: &str) -> String {
    content.replace("\r\n", "\n")
}

pub fn host_by_id(host_id: &str) -> Result<SshHost, String> {
    crate::modules::workspace::validate_ssh_host_id(host_id)?;
    let store = host_store();
    store.load_fallback();
    store
        .get(host_id)
        .ok_or_else(|| format!("unknown SSH host: {host_id}"))
    }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_maps_known_shells() {
        assert_eq!(ShellKind::classify("/bin/zsh"), ShellKind::Zsh);
        assert_eq!(ShellKind::classify("/usr/bin/bash"), ShellKind::Bash);
        assert_eq!(ShellKind::classify("/opt/homebrew/bin/fish"), ShellKind::Fish);
        assert_eq!(ShellKind::classify("/bin/sh"), ShellKind::Other);
    }

    #[test]
    fn dir_of_splits_parent() {
        assert_eq!(dir_of("zsh/.zshenv"), "zsh");
        assert_eq!(dir_of("bash/bashrc"), "bash");
        assert_eq!(dir_of("flat"), "");
    }

    #[test]
    fn unix_newlines_normalizes_crlf() {
        assert_eq!(unix_newlines("a\r\nb\r\n"), "a\nb\n");
        assert_eq!(unix_newlines("a\nb\n"), "a\nb\n");
    }
}
