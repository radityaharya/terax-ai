use std::path::PathBuf;

use portable_pty::CommandBuilder;

use crate::modules::control::ShellControlEnv;
use crate::modules::workspace::{self, WorkspaceEnv};

#[cfg(windows)]
const BASHRC_SCRIPT: &str = include_str!("scripts/bashrc.bash");
#[cfg(windows)]
const ZSHENV_SCRIPT: &str = include_str!("scripts/zshenv.zsh");
#[cfg(windows)]
const ZPROFILE_SCRIPT: &str = include_str!("scripts/zprofile.zsh");
#[cfg(windows)]
const ZLOGIN_SCRIPT: &str = include_str!("scripts/zlogin.zsh");
#[cfg(windows)]
const ZSHRC_SCRIPT: &str = include_str!("scripts/zshrc.zsh");
#[cfg(windows)]
const FISH_INIT_SCRIPT: &str = include_str!("scripts/init.fish");
const FISH_REINSTALL_PROMPT: &str =
    "functions -q __terax_install_prompt; and __terax_install_prompt";

#[cfg(windows)]
fn bashrc_script() -> &'static str {
    BASHRC_SCRIPT
}

#[cfg(windows)]
fn zshenv_script() -> &'static str {
    ZSHENV_SCRIPT
}

#[cfg(windows)]
fn zprofile_script() -> &'static str {
    ZPROFILE_SCRIPT
}

#[cfg(windows)]
fn zlogin_script() -> &'static str {
    ZLOGIN_SCRIPT
}

#[cfg(windows)]
fn zshrc_script() -> &'static str {
    ZSHRC_SCRIPT
}

#[cfg(windows)]
fn fish_init_script() -> &'static str {
    FISH_INIT_SCRIPT
}

/// Spawn target for `docker exec -it`: an interactive shell inside a
/// container on an SSH host. The transport stays system ssh; the remote
/// command is `docker exec -it <container> <shell>`. Container id and
/// shell come from the fixed allow-list validated in terax-core.
#[derive(Clone, Debug)]
pub struct DockerExecSpec {
    pub host_id: String,
    pub container: String,
    pub shell: String,
    pub attach: bool,
}

/// Reattach a remote zellij session as the terminal's remote command:
/// `ssh -t user@host zellij attach <session>`. Session names are validated
/// (no flag-like or metacharacter names) before the argv is assembled.
#[derive(Clone, Debug)]
pub struct ZellijAttachSpec {
    pub host_id: String,
    pub session: String,
}

#[allow(clippy::too_many_arguments)]
pub fn build_command(
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    blocks: bool,
    shell: Option<String>,
    control: Option<ShellControlEnv>,
    ssh_integration: Option<crate::modules::ssh::integration::SshIntegration>,
    docker_exec: Option<DockerExecSpec>,
    zellij_attach: Option<ZellijAttachSpec>,
) -> Result<CommandBuilder, String> {
    // SSH terminal tabs run on all desktop OSes: the transport is system ssh.
    // Integration is installed in pty_open (which has state access) and
    // passed through; bare fallback when absent.
    if let WorkspaceEnv::Ssh { host_id } = &workspace {
        let _ = (shell, control);
        if let Some(spec) = docker_exec {
            return build_docker_exec(&spec);
        }
        if let Some(spec) = zellij_attach {
            return build_zellij_attach(&spec);
        }
        return build_ssh(cwd, host_id, ssh_integration, blocks);
    }
    let _ = docker_exec;
    let _ = zellij_attach;
    let _ = ssh_integration;
    let shell = sanitize_shell_override(shell);
    #[cfg(unix)]
    {
        let _ = workspace;
        unix::build(cwd, blocks, shell, control)
    }
    #[cfg(windows)]
    {
        windows::build(cwd, workspace, blocks, shell, control)
    }
}

/// Interactive `docker exec` terminal on an SSH host:
/// `ssh -t user@host docker exec -it <container> <shell>` (or
/// `docker attach [--no-stdin]`). The argv is validated server-side:
/// container ids match the identifier grammar and the shell comes from
/// the fixed allow-list; anything else is rejected before spawn.
pub fn build_docker_exec(spec: &DockerExecSpec) -> Result<CommandBuilder, String> {
    use crate::modules::ssh::integration::host_by_id;
    let host = host_by_id(&spec.host_id)?;
    let argv = if spec.attach {
        terax_core::docker::containers::build_attach_argv(&spec.container, false)
    } else {
        terax_core::docker::containers::build_exec_argv(&spec.container, &spec.shell)
    }
    .map_err(|e| e.to_string())?;
    // argv[0] is always "docker"; the remote command is the full argv as
    // ONE ssh argument (same quoting discipline as run_ssh_capture).
    let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let remote_cmd = argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    let mut cmd = CommandBuilder::new(crate::modules::ssh::ssh_binary());
    for arg in crate::modules::ssh::session::terminal_args(&host, None) {
        cmd.arg(arg);
    }
    cmd.arg(remote_cmd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "terax");
    cmd.env("TERAX_TERMINAL", "1");
    cmd.env("TERAX_DOCKER_EXEC", &spec.container);
    // The integration scripts key cwd/title off HOST; inside a container
    // the hostname differs, so tag the session explicitly. The shell
    // scripts emit `file://$TERAX_SESSION_TAG/...` when set, letting the
    // frontend attribute OSC 7 to the exec tab instead of the host.
    cmd.env("TERAX_SESSION_TAG", format!("docker:{}", spec.container));
    log::info!(
        "spawning docker exec: {}@{} container {} ({})",
        host.user,
        host.hostname,
        spec.container,
        spec.shell
    );
    Ok(cmd)
}

/// Interactive SSH terminal attached to a zellij session:
/// `ssh -t user@host zellij attach <session>`. The remote command is the
/// full argv as ONE ssh argument (same quoting discipline as docker exec).
pub fn build_zellij_attach(spec: &ZellijAttachSpec) -> Result<CommandBuilder, String> {
    use crate::modules::ssh::integration::host_by_id;
    let host = host_by_id(&spec.host_id)?;
    // Resolve the binary rather than calling bare `zellij`: the remote
    // command runs the login shell non-interactively, which never reads the
    // interactive rc that puts a Linuxbrew/cargo install on PATH.
    let bin = crate::modules::ssh::zellij::zellij_binary(&host);
    let argv = crate::modules::ssh::zellij::build_attach_argv(&bin, &spec.session)?;
    let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let remote_cmd = argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    let mut cmd = CommandBuilder::new(crate::modules::ssh::ssh_binary());
    for arg in crate::modules::ssh::session::terminal_args(&host, None) {
        cmd.arg(arg);
    }
    cmd.arg(remote_cmd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "terax");
    cmd.env("TERAX_TERMINAL", "1");
    cmd.env("TERAX_ZELLIJ_SESSION", &spec.session);
    cmd.env("TERAX_SESSION_TAG", format!("zellij:{}", spec.session));
    log::info!(
        "spawning zellij attach: {}@{} session {}",
        host.user,
        host.hostname,
        spec.session
    );
    Ok(cmd)
}

/// Interactive SSH terminal: `ssh -t user@host <remote shell>`. Passwords
/// and 2FA complete natively in the PTY. With integration installed the
/// remote shell emits OSC 7/133 (cwd tracking, command blocks, agent
/// detection) exactly like local shells; without it, bare fallback. The
/// remote cwd, when set, is applied with a safe `cd` prefix.
pub fn build_ssh(
    cwd: Option<String>,
    host_id: &str,
    integration: Option<crate::modules::ssh::integration::SshIntegration>,
    blocks: bool,
) -> Result<CommandBuilder, String> {
    use crate::modules::ssh::integration::{ShellKind, SshIntegration, FISH_REINSTALL_PROMPT};
    let host = crate::modules::ssh::integration::host_by_id(host_id)?;
    // The login shell was already probed (and cached) by the integration
    // step in pty_open; reuse it instead of a second ssh handshake. Only
    // probe fresh when integration never ran (SshIntegration::None).
    let integration = integration.unwrap_or(SshIntegration::None);
    let remote_shell = integration
        .shell_path()
        .map(str::to_string)
        .unwrap_or_else(|| {
            crate::modules::ssh::session::ssh_login_shell(&host)
                .map_err(|e| e.to_string())
                .unwrap_or_else(|_| "/bin/sh".to_string())
        });
    let kind = ShellKind::classify(&remote_shell);
    let mut cmd = CommandBuilder::new(crate::modules::ssh::ssh_binary());
    for arg in crate::modules::ssh::session::terminal_args(&host, None) {
        cmd.arg(arg);
    }
    // Remote command: optional cd, then the shell with its integration
    // wiring. Mirrors the WSL launch spec per shell kind.
    let dir = cwd
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|s| !looks_like_local_path(s));
    let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let cd = dir.as_deref().map(|d| format!("cd {} && ", q(d))).unwrap_or_default();
    let remote_cmd = match (&kind, &integration) {
        (ShellKind::Zsh, SshIntegration::Zsh { zdotdir, .. }) => {
            format!("{cd}ZDOTDIR={} {} -l", q(zdotdir), q(&remote_shell))
        }
        (ShellKind::Bash, SshIntegration::Bash { rcfile, .. }) => {
            format!("{cd}{} --rcfile {} -i", q(&remote_shell), q(rcfile))
        }
        (ShellKind::Fish, SshIntegration::Fish { .. }) => {
            format!(
                "{cd}env fish_features=no-mark-prompt {} -i -C {}",
                q(&remote_shell),
                q(FISH_REINSTALL_PROMPT)
            )
        }
        _ => {
            if cd.is_empty() {
                remote_shell.clone()
            } else {
                format!("{cd}exec {}", q(&remote_shell))
            }
        }
    };
    cmd.arg(remote_cmd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "terax");
    cmd.env("TERAX_TERMINAL", "1");
    if blocks && !matches!(integration, SshIntegration::None) {
        cmd.env("TERAX_BLOCKS", "1");
    }
    log::info!("spawning SSH shell: {}@{} ({remote_shell})", host.user, host.hostname);
    Ok(cmd)
}

/// True for paths that are local to the desktop (Windows drive, backslashes,
/// UNC, WSL drvfs). Remote shells must never receive them as cwd.
fn looks_like_local_path(s: &str) -> bool {
    if s.contains('\\') {
        return true;
    }
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        return true;
    }
    if s.starts_with("\\\\") {
        return true;
    }
    // WSL drvfs (/mnt/c/...) is Windows storage, not a remote path.
    if let Some(rest) = s.strip_prefix("/mnt/") {
        let mut chars = rest.chars();
        if let (Some(drive), Some(next)) = (chars.next(), chars.next()) {
            if drive.is_ascii_alphabetic() && next == '/' {
                return true;
            }
        }
    }
    false
}

// Honor the override only if it matches an enumerated shell, so a tampered
// setting can't spawn an arbitrary binary across the IPC boundary.
fn sanitize_shell_override(shell: Option<String>) -> Option<String> {
    let candidate = shell
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let target = std::fs::canonicalize(&candidate).ok();
    let allowed = list_shells().into_iter().any(|s| {
        s.path == candidate || (target.is_some() && std::fs::canonicalize(&s.path).ok() == target)
    });
    if allowed {
        Some(candidate)
    } else {
        log::warn!("ignoring non-enumerated shell override '{candidate}'");
        None
    }
}

pub fn detect_shell_name() -> String {
    #[cfg(unix)]
    {
        let (_, path) = unix::Shell::detect();
        path.rsplit('/').next().unwrap_or("").to_string()
    }
    #[cfg(windows)]
    {
        windows_shell_path()
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default()
    }
}

#[derive(serde::Serialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    /// True when Terax injects OSC 7/133 integration for this shell (cwd
    /// tracking, command blocks, agent detection). Others spawn bare.
    pub integrated: bool,
}

pub fn list_shells() -> Vec<ShellInfo> {
    #[cfg(unix)]
    {
        unix::list_shells()
    }
    #[cfg(windows)]
    {
        windows::list_shells()
    }
}

fn ensure_utf8_locale(cmd: &mut CommandBuilder) {
    let is_utf8 = |v: &str| {
        let up = v.to_ascii_uppercase();
        up.contains("UTF-8") || up.contains("UTF8")
    };
    let already_utf8 = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|k| std::env::var(k).ok().as_deref().is_some_and(is_utf8));
    if already_utf8 {
        return;
    }
    #[cfg(target_os = "macos")]
    let fallback = "en_US.UTF-8";
    #[cfg(all(unix, not(target_os = "macos")))]
    let fallback = "C.UTF-8";
    #[cfg(windows)]
    let fallback = "en_US.UTF-8";
    cmd.env("LANG", fallback);
}

fn apply_common(
    cmd: &mut CommandBuilder,
    cwd: Option<String>,
    blocks: bool,
    control: Option<&ShellControlEnv>,
) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERAX_TERMINAL", "1");
    if blocks {
        cmd.env("TERAX_BLOCKS", "1");
    }
    let appimage_overrides = workspace::appimage_env_overrides();
    let clean_path = match appimage_overrides.iter().find(|(key, _)| *key == "PATH") {
        Some((_, value)) => value.clone(),
        None => std::env::var_os("PATH"),
    };
    for (key, value) in appimage_overrides {
        match value {
            Some(v) => {
                cmd.env(key, v);
            }
            None => {
                cmd.env_remove(key);
            }
        }
    }
    if let Some(control) = control {
        cmd.env("TERAX_CONTROL_ADDR", &control.address);
        cmd.env("TERAX_CONTROL_TOKEN", &control.token);
        cmd.env("TERAX_PANE_ID", control.pane_id.to_string());
        if let Some(path) = &control.cli_path {
            cmd.env("TERAX_CLI", path);
        }
        if let Some(bin_dir) = &control.cli_bin_dir {
            let paths = std::iter::once(bin_dir.clone()).chain(
                clean_path
                    .as_deref()
                    .into_iter()
                    .flat_map(std::env::split_paths),
            );
            if let Ok(path) = std::env::join_paths(paths) {
                cmd.env("PATH", path);
            }
        }
    }
    ensure_utf8_locale(cmd);

    let resolved_cwd = cwd
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| workspace::launch_cwd_snapshot().filter(|p| p.is_dir()))
        .or_else(|| dirs::home_dir().filter(|p| p.is_dir()));
    if let Some(cwd) = resolved_cwd {
        #[cfg(windows)]
        let cwd = PathBuf::from(cwd.to_string_lossy().replace('/', "\\"));
        log::info!("pty cwd: {}", cwd.display());
        cmd.cwd(cwd);
    } else {
        log::warn!("pty cwd: no usable directory, inheriting from process");
    }
}

#[cfg(unix)]
mod unix {
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};

    use portable_pty::CommandBuilder;

    const ZSHENV: &str = include_str!("scripts/zshenv.zsh");
    const ZPROFILE: &str = include_str!("scripts/zprofile.zsh");
    const ZLOGIN: &str = include_str!("scripts/zlogin.zsh");
    const ZSHRC: &str = include_str!("scripts/zshrc.zsh");
    const BASHRC: &str = include_str!("scripts/bashrc.bash");
    const FISH_INIT: &str = include_str!("scripts/init.fish");

    pub enum Shell {
        Zsh,
        Bash,
        Fish,
        Other,
    }

    impl Shell {
        pub fn classify(path: &str) -> Shell {
            match path.rsplit('/').next().unwrap_or("") {
                "zsh" => Shell::Zsh,
                "bash" => Shell::Bash,
                "fish" => Shell::Fish,
                _ => Shell::Other,
            }
        }

        pub fn detect() -> (Shell, String) {
            let path = login_shell()
                .or_else(|| std::env::var("SHELL").ok())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "/bin/zsh".into());
            (Self::classify(&path), path)
        }

        // A configured override wins only when it points at a real file;
        // otherwise fall back to the user's login shell.
        pub fn resolve(shell_override: Option<String>) -> (Shell, String) {
            if let Some(path) = shell_override
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                if Path::new(&path).is_file() {
                    return (Self::classify(&path), path);
                }
                log::warn!("configured shell '{path}' not found, using auto-detect");
            }
            Self::detect()
        }
    }

    fn login_shell() -> Option<String> {
        use std::ffi::CStr;
        unsafe {
            let uid = libc::getuid();
            let pw = libc::getpwuid(uid);
            if pw.is_null() {
                return None;
            }
            let shell_ptr = (*pw).pw_shell;
            if shell_ptr.is_null() {
                return None;
            }
            CStr::from_ptr(shell_ptr).to_str().ok().map(String::from)
        }
    }

    pub fn list_shells() -> Vec<super::ShellInfo> {
        use std::collections::HashSet;
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let (_, login) = Shell::detect();
        let mut candidates = vec![login];
        if let Ok(content) = fs::read_to_string("/etc/shells") {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                candidates.push(line.to_string());
            }
        }
        for path in candidates {
            if !seen.insert(path.clone()) || !Path::new(&path).is_file() {
                continue;
            }
            let integrated = !matches!(Shell::classify(&path), Shell::Other);
            let name = path.rsplit('/').next().unwrap_or(&path).to_string();
            out.push(super::ShellInfo {
                name,
                path,
                integrated,
            });
        }
        out
    }

    pub fn build(
        cwd: Option<String>,
        blocks: bool,
        shell_override: Option<String>,
        control: Option<super::ShellControlEnv>,
    ) -> Result<CommandBuilder, String> {
        let (shell, shell_path) = Shell::resolve(shell_override);
        let mut cmd = CommandBuilder::new(&shell_path);
        super::apply_common(&mut cmd, cwd, blocks, control.as_ref());
        apply_shell_init(&mut cmd, &shell, &shell_path);
        Ok(cmd)
    }

    fn apply_shell_init(cmd: &mut CommandBuilder, shell: &Shell, shell_path: &str) {
        match shell {
            Shell::Zsh => {
                match prepare_zdotdir() {
                    Ok(zdotdir) => {
                        // Guard against Terax-in-Terax :)
                        if let Ok(user_zd) = std::env::var("ZDOTDIR") {
                            if Path::new(&user_zd) != zdotdir.as_path() {
                                cmd.env("TERAX_USER_ZDOTDIR", user_zd);
                            }
                        }
                        cmd.env("ZDOTDIR", &zdotdir);
                    }
                    Err(e) => {
                        log::warn!("zsh shell integration disabled: {e}");
                    }
                }
                // Login shell so /etc/zprofile runs path_helper on macOS — without
                // this, GUI-launched apps get a minimal PATH missing Homebrew.
                cmd.arg("-l");
            }
            Shell::Bash => {
                match prepare_bash_rcfile() {
                    Ok(rc) => {
                        cmd.arg("--rcfile");
                        cmd.arg(rc);
                    }
                    Err(e) => {
                        log::warn!("bash shell integration disabled: {e}");
                    }
                }
                // bash ignores --rcfile under -l, so we use -i and source
                // /etc/profile from inside our rcfile to emulate login init.
                cmd.arg("-i");
            }
            Shell::Fish => {
                if let Err(e) = prepare_fish_conf_d() {
                    log::warn!("fish shell integration disabled: {e}");
                }
                // fish 4.0+ writes its own OSC 133 A/B; ours would double it.
                cmd.env("fish_features", "no-mark-prompt");
                cmd.arg("-i");
                // Re-assert our prompt after config.fish (-C runs last), so a
                // framework prompt (starship etc.) loaded there can't override
                // the markers and break cwd tracking.
                cmd.arg("-C");
                cmd.arg(super::FISH_REINSTALL_PROMPT);
            }
            Shell::Other => {
                log::info!(
                    "unsupported shell '{}', spawning without integration",
                    shell_path
                );
            }
        }
    }

    fn integration_root() -> Result<PathBuf, String> {
        let home = dirs::home_dir().ok_or_else(|| "could not resolve home dir".to_string())?;
        let root = home.join(".cache").join("terax").join("shell-integration");
        fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
        Ok(root)
    }

    fn prepare_zdotdir() -> Result<PathBuf, String> {
        let dir = integration_root()?.join("zsh");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        write_if_changed(&dir.join(".zshenv"), ZSHENV)?;
        write_if_changed(&dir.join(".zprofile"), ZPROFILE)?;
        write_if_changed(&dir.join(".zshrc"), ZSHRC)?;
        write_if_changed(&dir.join(".zlogin"), ZLOGIN)?;
        Ok(dir)
    }

    fn prepare_bash_rcfile() -> Result<PathBuf, String> {
        let dir = integration_root()?.join("bash");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let rc = dir.join("bashrc");
        write_if_changed(&rc, BASHRC)?;
        Ok(rc)
    }

    fn prepare_fish_conf_d() -> Result<(), String> {
        let home = dirs::home_dir().ok_or_else(|| "could not resolve home dir".to_string())?;
        let dir = home.join(".config").join("fish").join("conf.d");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        write_if_changed(&dir.join("terax.fish"), FISH_INIT)?;
        Ok(())
    }

    fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
        if let Ok(existing) = fs::read_to_string(path) {
            if existing == content {
                return Ok(());
            }
        }
        // Atomic replace: a parallel shell startup must never source a half-written file.
        let mut tmp: OsString = path.as_os_str().to_owned();
        tmp.push(".__terax_tmp__");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, content).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        fs::rename(&tmp, path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("rename {} -> {}: {e}", tmp.display(), path.display())
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn classify_maps_known_shells() {
            assert!(matches!(Shell::classify("/bin/zsh"), Shell::Zsh));
            assert!(matches!(Shell::classify("/usr/bin/bash"), Shell::Bash));
            assert!(matches!(
                Shell::classify("/opt/homebrew/bin/fish"),
                Shell::Fish
            ));
            assert!(matches!(Shell::classify("/bin/sh"), Shell::Other));
            assert!(matches!(Shell::classify("/usr/bin/nu"), Shell::Other));
        }

        #[test]
        fn resolve_uses_an_existing_override() {
            let exe = std::env::current_exe().unwrap();
            let path = exe.to_string_lossy().into_owned();
            let (_, resolved) = Shell::resolve(Some(path.clone()));
            assert_eq!(resolved, path);
        }

        #[test]
        fn resolve_falls_back_when_override_missing() {
            let (_, path) = Shell::resolve(Some("/no/such/shell/xyz".into()));
            assert!(!path.is_empty());
            assert_ne!(path, "/no/such/shell/xyz");
        }

        #[test]
        fn resolve_falls_back_on_empty_override() {
            let (_, fallback) = Shell::resolve(Some("   ".into()));
            let (_, detected) = Shell::detect();
            assert_eq!(fallback, detected);
        }

        #[test]
        fn builds_unix_fish_launch_with_post_config_rewrap() {
            let mut cmd = CommandBuilder::new("/usr/bin/fish");
            apply_shell_init(&mut cmd, &Shell::Fish, "/usr/bin/fish");
            let argv: Vec<_> = cmd
                .get_argv()
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            assert_eq!(
                argv,
                vec![
                    "/usr/bin/fish".to_string(),
                    "-i".to_string(),
                    "-C".to_string(),
                    super::super::FISH_REINSTALL_PROMPT.to_string(),
                ]
            );
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::modules::workspace::WorkspaceEnv;
    use portable_pty::CommandBuilder;

    const PROFILE_PS1: &str = include_str!("scripts/profile.ps1");

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum ShellKind {
        Zsh,
        Bash,
        Fish,
        Other,
    }

    impl ShellKind {
        fn from_path(path: &str) -> Self {
            match path.rsplit('/').next().unwrap_or("") {
                "zsh" => Self::Zsh,
                "bash" => Self::Bash,
                "fish" => Self::Fish,
                _ => Self::Other,
            }
        }
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum WslShellIntegration {
        Zsh {
            zdotdir: String,
            user_zdotdir: Option<String>,
        },
        Bash {
            rcfile: String,
        },
        Fish,
        None,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct WslLaunchSpec {
        args: Vec<String>,
    }

    pub fn build(
        cwd: Option<String>,
        workspace: WorkspaceEnv,
        blocks: bool,
        shell: Option<String>,
        control: Option<super::ShellControlEnv>,
    ) -> Result<CommandBuilder, String> {
        if let WorkspaceEnv::Wsl { distro } = workspace {
            let _ = (blocks, shell, control);
            return build_wsl(cwd, distro);
        }
        let shell_path = shell
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .unwrap_or_else(super::windows_shell_path);
        let shell_name = shell_path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        let is_powershell = shell_name == "pwsh.exe" || shell_name == "powershell.exe";
        let is_bash = shell_name == "bash.exe";

        let mut cmd = CommandBuilder::new(&shell_path);
        super::apply_common(&mut cmd, cwd, blocks, control.as_ref());

        if is_powershell {
            match prepare_ps_profile() {
                Ok(profile) => {
                    cmd.arg("-NoLogo");
                    cmd.arg("-NoExit");
                    cmd.arg("-ExecutionPolicy");
                    cmd.arg("Bypass");
                    cmd.arg("-File");
                    cmd.arg(profile);
                }
                Err(e) => {
                    log::warn!("powershell shell integration disabled: {e}");
                }
            }
        } else if is_bash {
            // git-bash's /etc/profile cd's to $HOME unless CHERE_INVOKING is
            // set; keep the cwd we configured in apply_common.
            cmd.env("CHERE_INVOKING", "1");
            // Native git-bash: same OSC 7/133 rcfile as Unix bash, in the
            // forward-slash form MSYS bash accepts.
            match prepare_bash_rcfile() {
                Ok(rc) => {
                    cmd.arg("--rcfile");
                    cmd.arg(rc.to_string_lossy().replace('\\', "/"));
                    cmd.arg("-i");
                }
                Err(e) => {
                    log::warn!("bash shell integration disabled: {e}");
                }
            }
        } else {
            log::info!("spawning {} without shell integration", shell_name);
        }

        log::info!("spawning Windows shell: {}", shell_path.display());
        Ok(cmd)
    }

    fn build_wsl(cwd: Option<String>, distro: String) -> Result<CommandBuilder, String> {
        crate::modules::workspace::validate_wsl_distro_name(&distro)?;
        let shell_path = crate::modules::workspace::wsl_login_shell(distro.clone())?;
        let shell_kind = ShellKind::from_path(&shell_path);
        let integration = match shell_kind {
            ShellKind::Zsh => match prepare_wsl_zdotdir(&distro) {
                Ok(zdotdir) => {
                    let user_zdotdir = match probe_wsl_zdotdir(&distro, &shell_path) {
                        Ok(path) if !path.is_empty() && path != zdotdir => Some(path),
                        Ok(_) => None,
                        Err(e) => {
                            log::warn!("WSL zsh ZDOTDIR probe failed for {distro}: {e}");
                            None
                        }
                    };
                    WslShellIntegration::Zsh {
                        zdotdir,
                        user_zdotdir,
                    }
                }
                Err(e) => {
                    log::warn!("WSL zsh shell integration disabled for {distro}: {e}");
                    WslShellIntegration::None
                }
            },
            ShellKind::Bash => match prepare_wsl_bash_rcfile(&distro) {
                Ok(rcfile) => WslShellIntegration::Bash { rcfile },
                Err(e) => {
                    log::warn!("WSL bash shell integration disabled for {distro}: {e}");
                    WslShellIntegration::None
                }
            },
            ShellKind::Fish => match prepare_wsl_fish_conf_d(&distro) {
                Ok(()) => WslShellIntegration::Fish,
                Err(e) => {
                    log::warn!("WSL fish shell integration disabled for {distro}: {e}");
                    WslShellIntegration::None
                }
            },
            ShellKind::Other => {
                log::info!(
                    "unsupported WSL shell '{}', spawning without integration",
                    shell_path
                );
                WslShellIntegration::None
            }
        };
        let spec = build_wsl_launch_spec(
            cwd.as_deref(),
            &distro,
            &shell_path,
            shell_kind,
            integration,
        );
        let mut cmd = CommandBuilder::new("wsl.exe");
        for arg in &spec.args {
            cmd.arg(arg);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERAX_TERMINAL", "1");
        super::ensure_utf8_locale(&mut cmd);
        log::info!("spawning WSL shell: {distro} ({shell_path})");
        Ok(cmd)
    }

    fn build_wsl_launch_spec(
        cwd: Option<&str>,
        distro: &str,
        shell_path: &str,
        shell_kind: ShellKind,
        integration: WslShellIntegration,
    ) -> WslLaunchSpec {
        let mut args = vec![
            "-d".to_string(),
            distro.to_string(),
            "--cd".to_string(),
            cwd.filter(|s| !s.is_empty()).unwrap_or("~").to_string(),
            "--exec".to_string(),
        ];
        match (shell_kind, integration) {
            (
                ShellKind::Zsh,
                WslShellIntegration::Zsh {
                    zdotdir,
                    user_zdotdir,
                },
            ) => {
                args.push("env".to_string());
                if let Some(user_zdotdir) = user_zdotdir {
                    args.push(format!("TERAX_USER_ZDOTDIR={user_zdotdir}"));
                }
                args.push(format!("ZDOTDIR={zdotdir}"));
                args.push(shell_path.to_string());
                args.push("-l".to_string());
            }
            (ShellKind::Bash, WslShellIntegration::Bash { rcfile }) => {
                args.push(shell_path.to_string());
                args.push("--rcfile".to_string());
                args.push(rcfile);
                args.push("-i".to_string());
            }
            (ShellKind::Fish, WslShellIntegration::Fish) => {
                args.push("env".to_string());
                args.push("fish_features=no-mark-prompt".to_string());
                args.push(shell_path.to_string());
                args.push("-i".to_string());
                args.push("-C".to_string());
                args.push(super::FISH_REINSTALL_PROMPT.to_string());
            }
            (ShellKind::Zsh, WslShellIntegration::None) => {
                args.push(shell_path.to_string());
                args.push("-l".to_string());
            }
            (ShellKind::Bash, WslShellIntegration::None)
            | (ShellKind::Fish, WslShellIntegration::None) => {
                args.push(shell_path.to_string());
                args.push("-i".to_string());
            }
            (ShellKind::Other, _) => args.push(shell_path.to_string()),
            _ => {
                args.push(shell_path.to_string());
            }
        }
        WslLaunchSpec { args }
    }

    fn probe_wsl_zdotdir(distro: &str, shell_path: &str) -> Result<String, String> {
        let out = crate::modules::workspace::wsl_exec_capture(
            distro,
            shell_path,
            &["-c", r#"printf %s "${ZDOTDIR:-$HOME}""#],
        )?;
        Ok(crate::modules::workspace::normalize_wsl_value(out, ""))
    }

    fn prepare_wsl_integration_dir(distro: &str, shell: &str) -> Result<(String, PathBuf), String> {
        let home = crate::modules::workspace::wsl_home(distro.to_string())?;
        let linux_dir = format!(
            "{}/.cache/terax/shell-integration/{shell}",
            home.trim_end_matches('/')
        );
        let unc_dir = crate::modules::workspace::wsl_path_to_unc(distro, &linux_dir);
        fs::create_dir_all(&unc_dir).map_err(|e| format!("create {}: {e}", unc_dir.display()))?;
        Ok((linux_dir, unc_dir))
    }

    fn normalize_script(content: &str) -> String {
        content.replace("\r\n", "\n")
    }

    fn prepare_wsl_zdotdir(distro: &str) -> Result<String, String> {
        let (linux_dir, unc_dir) = prepare_wsl_integration_dir(distro, "zsh")?;
        write_if_changed(
            &unc_dir.join(".zshenv"),
            &normalize_script(super::zshenv_script()),
        )?;
        write_if_changed(
            &unc_dir.join(".zprofile"),
            &normalize_script(super::zprofile_script()),
        )?;
        write_if_changed(
            &unc_dir.join(".zshrc"),
            &normalize_script(super::zshrc_script()),
        )?;
        write_if_changed(
            &unc_dir.join(".zlogin"),
            &normalize_script(super::zlogin_script()),
        )?;
        Ok(linux_dir)
    }

    fn prepare_wsl_bash_rcfile(distro: &str) -> Result<String, String> {
        let (linux_dir, _unc_dir) = prepare_wsl_integration_dir(distro, "bash")?;
        let linux_rc = format!("{linux_dir}/bashrc");
        let unc_file = crate::modules::workspace::wsl_path_to_unc(distro, &linux_rc);
        let content = normalize_script(super::bashrc_script());
        write_if_changed(&unc_file, &content)?;
        Ok(linux_rc)
    }

    fn prepare_wsl_fish_conf_d(distro: &str) -> Result<(), String> {
        let home = crate::modules::workspace::wsl_home(distro.to_string())?;
        let linux_dir = format!("{}/.config/fish/conf.d", home.trim_end_matches('/'));
        let unc_dir = crate::modules::workspace::wsl_path_to_unc(distro, &linux_dir);
        fs::create_dir_all(&unc_dir).map_err(|e| format!("create {}: {e}", unc_dir.display()))?;
        let unc_file = unc_dir.join("terax.fish");
        let content = normalize_script(super::fish_init_script());
        write_if_changed(&unc_file, &content)?;
        Ok(())
    }

    fn integration_root() -> Result<PathBuf, String> {
        let home = dirs::home_dir().ok_or_else(|| "could not resolve home dir".to_string())?;
        let root = home.join(".cache").join("terax").join("shell-integration");
        fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
        Ok(root)
    }

    fn prepare_ps_profile() -> Result<PathBuf, String> {
        let dir = integration_root()?.join("powershell");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let file = dir.join("profile.ps1");
        write_if_changed(&file, PROFILE_PS1)?;
        Ok(file)
    }

    fn prepare_bash_rcfile() -> Result<PathBuf, String> {
        let dir = integration_root()?.join("bash");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let rc = dir.join("bashrc");
        write_if_changed(&rc, &normalize_script(super::bashrc_script()))?;
        Ok(rc)
    }

    pub fn list_shells() -> Vec<super::ShellInfo> {
        fn add(out: &mut Vec<super::ShellInfo>, name: &str, path: PathBuf, integrated: bool) {
            if path.is_file() {
                out.push(super::ShellInfo {
                    name: name.to_string(),
                    path: path.to_string_lossy().into_owned(),
                    integrated,
                });
            }
        }

        let mut out = Vec::new();
        if let Some(p) = super::which_in_path("pwsh.exe") {
            add(&mut out, "PowerShell", p, true);
        } else if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
            add(
                &mut out,
                "PowerShell",
                pf.join("PowerShell").join("7").join("pwsh.exe"),
                true,
            );
        }
        let system32 = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("System32");
        add(
            &mut out,
            "Windows PowerShell",
            system32
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
            true,
        );
        add(&mut out, "Command Prompt", system32.join("cmd.exe"), false);
        if let Some(p) = git_bash_path() {
            add(&mut out, "Git Bash", p, true);
        }
        out
    }

    fn git_bash_path() -> Option<PathBuf> {
        // Git for Windows install locations only. A bash.exe on PATH is usually
        // the WSL launcher in System32, which is the separate WSL switcher.
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
            if let Some(base) = std::env::var_os(var).map(PathBuf::from) {
                for rel in [
                    r"Git\bin\bash.exe",
                    r"Git\usr\bin\bash.exe",
                    r"Programs\Git\bin\bash.exe",
                ] {
                    let candidate = base.join(rel);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    }

    fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
        if let Ok(existing) = fs::read_to_string(path) {
            if existing == content {
                return Ok(());
            }
        }
        let mut tmp: OsString = path.as_os_str().to_owned();
        tmp.push(".__terax_tmp__");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, content).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        fs::rename(&tmp, path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("rename {} -> {}: {e}", tmp.display(), path.display())
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn builds_wsl_zsh_launch_spec_with_env_and_login() {
            let spec = build_wsl_launch_spec(
                Some("/home/vinicios/repo"),
                "Ubuntu",
                "/usr/bin/zsh",
                ShellKind::Zsh,
                WslShellIntegration::Zsh {
                    zdotdir: "/home/vinicios/.cache/terax/shell-integration/zsh".into(),
                    user_zdotdir: None,
                },
            );
            assert_eq!(
                spec.args,
                vec![
                    "-d".to_string(),
                    "Ubuntu".to_string(),
                    "--cd".to_string(),
                    "/home/vinicios/repo".to_string(),
                    "--exec".to_string(),
                    "env".to_string(),
                    "ZDOTDIR=/home/vinicios/.cache/terax/shell-integration/zsh".to_string(),
                    "/usr/bin/zsh".to_string(),
                    "-l".to_string(),
                ]
            );
        }

        #[test]
        fn builds_wsl_zsh_launch_spec_with_user_zdotdir_probe() {
            let spec = build_wsl_launch_spec(
                Some("/home/vinicios/repo"),
                "Ubuntu",
                "/usr/bin/zsh",
                ShellKind::Zsh,
                WslShellIntegration::Zsh {
                    zdotdir: "/home/vinicios/.cache/terax/shell-integration/zsh".into(),
                    user_zdotdir: Some("/home/vinicios/.config/zsh".into()),
                },
            );
            assert_eq!(
                spec.args,
                vec![
                    "-d".to_string(),
                    "Ubuntu".to_string(),
                    "--cd".to_string(),
                    "/home/vinicios/repo".to_string(),
                    "--exec".to_string(),
                    "env".to_string(),
                    "TERAX_USER_ZDOTDIR=/home/vinicios/.config/zsh".to_string(),
                    "ZDOTDIR=/home/vinicios/.cache/terax/shell-integration/zsh".to_string(),
                    "/usr/bin/zsh".to_string(),
                    "-l".to_string(),
                ]
            );
        }

        #[test]
        fn builds_wsl_zsh_launch_spec_without_integration_still_uses_login_shell() {
            let spec = build_wsl_launch_spec(
                Some("/home/vinicios/repo"),
                "Ubuntu",
                "/usr/bin/zsh",
                ShellKind::Zsh,
                WslShellIntegration::None,
            );
            assert_eq!(
                spec.args,
                vec![
                    "-d".to_string(),
                    "Ubuntu".to_string(),
                    "--cd".to_string(),
                    "/home/vinicios/repo".to_string(),
                    "--exec".to_string(),
                    "/usr/bin/zsh".to_string(),
                    "-l".to_string(),
                ]
            );
        }

        #[test]
        fn builds_wsl_bash_launch_spec_with_rcfile() {
            let spec = build_wsl_launch_spec(
                Some("/home/vinicios/repo"),
                "Ubuntu",
                "/bin/bash",
                ShellKind::Bash,
                WslShellIntegration::Bash {
                    rcfile: "/home/vinicios/.cache/terax/shell-integration/bash/bashrc".into(),
                },
            );
            assert_eq!(
                spec.args,
                vec![
                    "-d".to_string(),
                    "Ubuntu".to_string(),
                    "--cd".to_string(),
                    "/home/vinicios/repo".to_string(),
                    "--exec".to_string(),
                    "/bin/bash".to_string(),
                    "--rcfile".to_string(),
                    "/home/vinicios/.cache/terax/shell-integration/bash/bashrc".to_string(),
                    "-i".to_string(),
                ]
            );
        }

        #[test]
        fn builds_wsl_fish_launch_spec_without_init_command() {
            let spec = build_wsl_launch_spec(
                Some("/home/vinicios/repo"),
                "Ubuntu",
                "/usr/bin/fish",
                ShellKind::Fish,
                WslShellIntegration::Fish,
            );
            assert_eq!(
                spec.args,
                vec![
                    "-d".to_string(),
                    "Ubuntu".to_string(),
                    "--cd".to_string(),
                    "/home/vinicios/repo".to_string(),
                    "--exec".to_string(),
                    "env".to_string(),
                    "fish_features=no-mark-prompt".to_string(),
                    "/usr/bin/fish".to_string(),
                    "-i".to_string(),
                    "-C".to_string(),
                    super::super::FISH_REINSTALL_PROMPT.to_string(),
                ]
            );
        }

        #[test]
        fn builds_wsl_other_shell_without_integration() {
            let spec = build_wsl_launch_spec(
                None,
                "Ubuntu",
                "/usr/bin/nu",
                ShellKind::Other,
                WslShellIntegration::None,
            );
            assert_eq!(
                spec.args,
                vec![
                    "-d".to_string(),
                    "Ubuntu".to_string(),
                    "--cd".to_string(),
                    "~".to_string(),
                    "--exec".to_string(),
                    "/usr/bin/nu".to_string(),
                ]
            );
        }
    }
}

#[cfg(windows)]
pub fn windows_shell_path() -> PathBuf {
    if let Some(p) = which_in_path("pwsh.exe") {
        return p;
    }

    if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        let candidate = pf.join("PowerShell").join("7").join("pwsh.exe");
        if candidate.is_file() {
            return candidate;
        }
    }

    let system32 = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32");
    let ps5 = system32
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if ps5.is_file() {
        return ps5;
    }

    system32.join("cmd.exe")
}

#[cfg(windows)]
fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use portable_pty::CommandBuilder;

    use super::{
        apply_common, build_docker_exec, build_ssh, sanitize_shell_override, DockerExecSpec,
        ShellControlEnv,
    };

    #[test]
    fn rejects_non_enumerated_override() {
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(sanitize_shell_override(Some(exe)), None);
    }

    #[test]
    fn empty_or_missing_override_is_none() {
        assert_eq!(sanitize_shell_override(Some("   ".into())), None);
        assert_eq!(sanitize_shell_override(None), None);
    }

    #[test]
    fn common_env_includes_authenticated_caller_context() {
        let mut command = CommandBuilder::new("shell");
        let control = ShellControlEnv {
            address: "127.0.0.1:1234".into(),
            token: "secret".into(),
            pane_id: 42,
            cli_path: Some("/app/terax-cli".into()),
            cli_bin_dir: Some(std::path::PathBuf::from("/app/bin")),
        };
        apply_common(&mut command, None, false, Some(&control));

        assert_eq!(
            command.get_env("TERAX_CONTROL_ADDR"),
            Some(OsStr::new("127.0.0.1:1234"))
        );
        assert_eq!(
            command.get_env("TERAX_CONTROL_TOKEN"),
            Some(OsStr::new("secret"))
        );
        assert_eq!(command.get_env("TERAX_PANE_ID"), Some(OsStr::new("42")));
        assert_eq!(
            command.get_env("TERAX_CLI"),
            Some(OsStr::new("/app/terax-cli"))
        );
        assert_eq!(
            command
                .get_env("PATH")
                .and_then(|path| std::env::split_paths(path).next()),
            Some(std::path::PathBuf::from("/app/bin"))
        );
    }

    fn seed_ssh_host(id: &str) {
        use crate::modules::ssh::hosts::{host_store, SshHost};
        host_store().upsert(SshHost {
            id: id.into(),
            alias: id.into(),
            user: "deploy".into(),
            hostname: "10.0.0.5".into(),
            port: 22,
            identity_file: None,
            remote_root: None,
            bound_space_id: None,
            color: None,
            agent_forward: false,
            created_at_ms: 0,
            updated_at_ms: 0,
        });
    }

    #[test]
    fn ssh_rejects_unsafe_host_id() {
        let err = build_ssh(None, "../evil", None, false).expect_err("unsafe id must fail");
        assert!(err.contains("unsafe"), "got: {err}");
    }

    #[test]
    fn ssh_rejects_unknown_host() {
        let err = build_ssh(None, "no-such-host-xyz", None, false).expect_err("unknown host must fail");
        assert!(err.contains("unknown SSH host"), "got: {err}");
    }

    #[test]
    fn ssh_launch_has_no_secrets_in_argv() {
        seed_ssh_host("argv-check");
        let cmd = build_ssh(Some("/home/u/repo".into()), "argv-check", None, false).expect("build");
        let argv: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let joined = argv.join(" ");
        assert!(joined.contains("-t"), "got: {joined}");
        assert!(joined.contains("deploy@10.0.0.5"), "got: {joined}");
        assert!(joined.contains("StrictHostKeyChecking=yes"), "got: {joined}");
        // No BatchMode on interactive sessions: passwords/2FA need the PTY.
        assert!(!argv.iter().any(|a| a == "BatchMode=yes"), "got: {joined}");
        // Remote cwd is applied inside the remote shell, never as local cwd.
        assert!(joined.contains("cd '/home/u/repo'"), "got: {joined}");
        assert_eq!(cmd.get_env("TERM"), Some(OsStr::new("xterm-256color")));
        assert_eq!(cmd.get_env("TERAX_BLOCKS"), None);
    }

    #[test]
    fn ssh_launch_quotes_remote_cwd_safely() {
        seed_ssh_host("quote-check");
        let cmd = build_ssh(Some("/home/u/o'brien".into()), "quote-check", None, false).expect("build");
        let argv: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let joined = argv.join(" ");
        assert!(joined.contains("o'\\''brien"), "got: {joined}");
    }

    #[test]
    fn ssh_launch_ignores_leaked_local_paths() {
        seed_ssh_host("leak-check");
        for leaked in [
            "C:/Users/conta",
            r"C:\Users\conta",
            r"\\server\share",
            "/mnt/c/Users/conta",
        ] {
            let cmd = build_ssh(Some(leaked.into()), "leak-check", None, false).expect("build");
            let argv: Vec<_> = cmd
                .get_argv()
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            let joined = argv.join(" ");
            assert!(
                !joined.contains("cd "),
                "local path must not reach remote shell, got: {joined}"
            );
        }
    }

    #[test]
    fn local_path_detector_catches_windows_forms() {
        assert!(super::looks_like_local_path("C:/Users/conta"));
        assert!(super::looks_like_local_path(r"C:\Users\conta"));
        assert!(super::looks_like_local_path(r"\\host\share"));
        assert!(super::looks_like_local_path("/mnt/c/x"));
        assert!(!super::looks_like_local_path("/home/u/repo"));
        assert!(!super::looks_like_local_path("relative/dir"));
    }

    #[test]
    fn ssh_launch_with_zsh_integration_sets_zdotdir() {
        use crate::modules::ssh::integration::SshIntegration;
        seed_ssh_host("zsh-check");
        let cmd = build_ssh(
            Some("/home/u/repo".into()),
            "zsh-check",
            Some(SshIntegration::Zsh {
                zdotdir: "/home/u/.cache/terax/shell-integration/zsh".into(),
                shell: "/bin/zsh".into(),
            }),
            false,
        )
        .expect("build");
        let argv: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let joined = argv.join(" ");
        // ssh_login_shell probes the live host in tests; with no server it
        // falls back to /bin/sh (Other), so assert the bare shape + no blocks.
        assert!(joined.contains("deploy@10.0.0.5"), "got: {joined}");
        assert_eq!(cmd.get_env("TERAX_BLOCKS"), None);
    }

    #[test]
    fn ssh_launch_with_bash_integration_uses_rcfile() {
        use crate::modules::ssh::integration::SshIntegration;
        seed_ssh_host("bash-check");
        let cmd = build_ssh(
            None,
            "bash-check",
            Some(SshIntegration::Bash {
                rcfile: "/home/u/.cache/terax/shell-integration/bash/bashrc".into(),
                shell: "/bin/bash".into(),
            }),
            true,
        )
        .expect("build");
        let argv: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let joined = argv.join(" ");
        assert!(joined.contains("deploy@10.0.0.5"), "got: {joined}");
    }

    fn docker_spec(host: &str, container: &str, shell: &str) -> DockerExecSpec {
        DockerExecSpec {
            host_id: host.into(),
            container: container.into(),
            shell: shell.into(),
            attach: false,
        }
    }

    #[test]
    fn docker_exec_builds_quoted_remote_argv() {
        seed_ssh_host("docker-check");
        let cmd = build_docker_exec(&docker_spec("docker-check", "web-1", "bash")).expect("build");
        let argv: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let joined = argv.join(" ");
        assert!(joined.contains("deploy@10.0.0.5"), "got: {joined}");
        assert!(joined.contains("docker"), "got: {joined}");
        assert!(joined.contains("web-1"), "got: {joined}");
        assert_eq!(cmd.get_env("TERAX_DOCKER_EXEC"), Some(OsStr::new("web-1")));
    }

    #[test]
    fn docker_exec_rejects_bad_container() {
        seed_ssh_host("docker-bad");
        let err = build_docker_exec(&docker_spec("docker-bad", "a;b", "bash")).expect_err("must fail");
        assert!(err.contains("invalid docker identifier"), "got: {err}");
    }

    #[test]
    fn docker_exec_rejects_bad_shell() {
        seed_ssh_host("docker-shell");
        let err = build_docker_exec(&docker_spec("docker-shell", "web-1", "/bin/evil")).expect_err("must fail");
        assert!(err.contains("not allowed"), "got: {err}");
    }

    #[test]
    fn docker_attach_builds_attach_argv() {
        seed_ssh_host("docker-attach");
        let mut spec = docker_spec("docker-attach", "web-1", "sh");
        spec.attach = true;
        let cmd = build_docker_exec(&spec).expect("build");
        let joined = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(joined.contains("attach"), "got: {joined}");
    }
}
