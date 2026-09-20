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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    Zsh { zdotdir: String, shell: String },
    Bash { rcfile: String, shell: String },
    Fish { shell: String },
    /// Bare shell: no integration scripts installed. Still carries the
    /// resolved login shell so the spawn path skips its own probe.
    Plain { shell: String },
    None,
}

impl SshIntegration {
    /// Remote login shell carried alongside the integration wiring, if any.
    pub fn shell_path(&self) -> Option<&str> {
        match self {
            SshIntegration::Zsh { shell, .. }
            | SshIntegration::Bash { shell, .. }
            | SshIntegration::Fish { shell }
            | SshIntegration::Plain { shell } => Some(shell),
            SshIntegration::None => None,
        }
    }
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
    // One handshake resolves home, login shell, and the installed agent
    // version. Only skip it when every fact is already cached and the agent
    // was verified this app run; otherwise the spawn path used to pay three
    // separate connections (version probe + home + login shell) here.
    let cached = ssh.session.get(host_id);
    let probed_version = if cached.home.is_some()
        && cached.login_shell.is_some()
        && cached.agent_verified
    {
        None
    } else {
        let facts = super::session::probe_remote_facts(&host).map_err(|e| e.to_string())?;
        let version = facts.agent_version.clone();
        ssh.session.update(host_id, |f| {
            f.home = Some(facts.home.clone());
            if !facts.login_shell.is_empty() {
                f.login_shell = Some(facts.login_shell.clone());
            }
            // Always overwrite: an empty version (agent absent) must clear
            // any persisted version so a later launch re-probes instead of
            // trusting a stale on-disk token.
            f.agent_version = if facts.agent_version.is_empty() {
                None
            } else {
                Some(facts.agent_version.clone())
            };
            f.agent_verified = terax_control_protocol::remote_agent_matches(&facts.agent_version);
        });
        Some(version)
    };
    let remote_bin = super::commands::ensure_remote_agent_with(
        &host,
        Some(&ssh.session),
        probed_version.as_deref(),
    )?;
    // Home: the persisted record wins, then the cached/probed value.
    let remote_root = match host.remote_root.clone().filter(|r| !r.is_empty()) {
        Some(root) => {
            ssh.session.update(host_id, |f| {
                if f.home.is_none() {
                    f.home = Some(root.clone());
                }
            });
            root
        }
        None => ssh
            .session
            .get(host_id)
            .home
            .ok_or_else(|| "could not resolve remote home".to_string())?,
    };
    let shell_path = ssh
        .session
        .get(host_id)
        .login_shell
        .ok_or_else(|| "could not resolve remote login shell".to_string())?;
    Ok(ensure_remote_integration(
        // Return the resolved shell too so the PTY spawn path doesn't
        // re-probe it (that was a duplicate ssh handshake per terminal).
        &ssh.rpc,
        host_id,
        &host,
        &remote_bin,
        &remote_root,
        &shell_path,
    ))
}

/// Installs the Terax shell-integration scripts on the remote host via one
/// batched `fs_write_files` RPC and returns the launch wiring for the
/// detected login shell. The old path issued fs_create_dir + fs_write_file
/// per file: four round trips for zsh, each of which could grow the RPC pool
/// to another full SSH handshake on Windows. Best-effort: any failure
/// degrades to `None` (bare shell) with a warning, never a spawn failure.
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
        return SshIntegration::Plain {
            shell: shell_path.to_string(),
        };
    }
    let base = format!("{}/.cache/terax/shell-integration", remote_root.trim_end_matches('/'));
    let home = remote_root.trim_end_matches('/');
    let plan = integration_files(kind, &base, home);
    let files: Vec<serde_json::Value> = plan
        .iter()
        .map(|(path, content)| json!({ "path": path, "content": content }))
        .collect();
    let result = rpc
        .request(
            host_id,
            terax_control_protocol::REMOTE_METHOD_FS_WRITE_FILES,
            json!({ "files": files }),
            remote_bin,
            remote_root,
        )
        .map(|_| match kind {
            ShellKind::Zsh => SshIntegration::Zsh {
                zdotdir: format!("{base}/zsh"),
                shell: shell_path.to_string(),
            },
            ShellKind::Bash => SshIntegration::Bash {
                rcfile: format!("{base}/bash/bashrc"),
                shell: shell_path.to_string(),
            },
            ShellKind::Fish => SshIntegration::Fish {
                shell: shell_path.to_string(),
            },
            ShellKind::Other => SshIntegration::Plain {
                shell: shell_path.to_string(),
            },
        });
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

/// (path, content) plan for a shell's integration install. Pure so the
/// batch payload, paths, and per-shell file set are lockable in a test
/// without a live host. Zsh gets its four startup files under a private
/// ZDOTDIR; bash gets one rcfile; fish must live in the real home conf.d.
fn integration_files(kind: ShellKind, base: &str, home: &str) -> Vec<(String, String)> {
    match kind {
        ShellKind::Zsh => vec![
            (format!("{base}/zsh/.zshenv"), unix_newlines(ZSHENV_SCRIPT)),
            (format!("{base}/zsh/.zprofile"), unix_newlines(ZPROFILE_SCRIPT)),
            (format!("{base}/zsh/.zshrc"), unix_newlines(ZSHRC_SCRIPT)),
            (format!("{base}/zsh/.zlogin"), unix_newlines(ZLOGIN_SCRIPT)),
        ],
        ShellKind::Bash => vec![(format!("{base}/bash/bashrc"), unix_newlines(BASHRC_SCRIPT))],
        ShellKind::Fish => vec![(
            format!("{home}/.config/fish/conf.d/terax.fish"),
            unix_newlines(FISH_INIT_SCRIPT),
        )],
        ShellKind::Other => Vec::new(),
    }
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
    fn zsh_plan_writes_four_files_under_the_cache_base() {
        let base = "/home/u/.cache/terax/shell-integration";
        let plan = integration_files(ShellKind::Zsh, base, "/home/u");
        let paths: Vec<&str> = plan.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "/home/u/.cache/terax/shell-integration/zsh/.zshenv",
                "/home/u/.cache/terax/shell-integration/zsh/.zprofile",
                "/home/u/.cache/terax/shell-integration/zsh/.zshrc",
                "/home/u/.cache/terax/shell-integration/zsh/.zlogin",
            ]
        );
    }

    #[test]
    fn bash_plan_writes_one_rcfile() {
        let plan = integration_files(ShellKind::Bash, "/h/.cache/terax/shell-integration", "/h");
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].0, "/h/.cache/terax/shell-integration/bash/bashrc");
    }

    #[test]
    fn fish_plan_targets_real_home_conf_d() {
        let plan = integration_files(
            ShellKind::Fish,
            "/h/.cache/terax/shell-integration",
            "/h",
        );
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].0, "/h/.config/fish/conf.d/terax.fish");
    }

    #[test]
    fn unix_newlines_normalizes_crlf() {
        assert_eq!(unix_newlines("a\r\nb\r\n"), "a\nb\n");
        assert_eq!(unix_newlines("a\nb\n"), "a\nb\n");
    }
}
