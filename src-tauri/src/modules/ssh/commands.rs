use super::config::{parse_ssh_config, ImportedHost};
use super::errors::{classify_probe_output, AuthHint, SshError};
use super::hosts::{
    host_id_for, host_store, imported_to_fields, normalize_host_input, now_ms, validate_host_id,
    SshHost, SshHostInput,
};
use super::known_hosts::{default_known_hosts_path, host_key_status, scan_host_keys, ScannedKey};
use super::session::{probe_auth, ssh_home, ssh_login_shell};

fn err(e: SshError) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn ssh_list_hosts(app: tauri::AppHandle) -> Result<Vec<SshHost>, String> {
    let store = host_store();
    store.load(&app);
    Ok(store.list())
}

#[tauri::command]
pub async fn ssh_save_host(
    app: tauri::AppHandle,
    input: SshHostInput,
) -> Result<SshHost, String> {
    let fields = normalize_host_input(&input).map_err(|m| m)?;
    let now = now_ms();
    let store = host_store();
    let (id, created) = match input.id {
        Some(raw) => {
            let id = raw.trim().to_string();
            validate_host_id(&id)?;
            let created = store.get(&id).map(|h| h.created_at_ms).unwrap_or(now);
            (id, created)
        }
        None => {
            let mut id = host_id_for(&fields.alias);
            if id.is_empty() || store.get(&id).is_some() {
                id = format!("{id}-{now:x}");
            }
            validate_host_id(&id)?;
            (id, now)
        }
    };
    let bound = store.get(&id).and_then(|h| h.bound_space_id);
    let host = SshHost {
        id,
        alias: fields.alias,
        user: fields.user,
        hostname: fields.hostname,
        port: fields.port,
        identity_file: fields.identity_file,
        remote_root: fields.remote_root,
        bound_space_id: bound,
        color: fields.color,
        agent_forward: fields.agent_forward,
        created_at_ms: created,
        updated_at_ms: now,
    };
    store.upsert(host.clone());
    store.persist(&app)?;
    Ok(host)
}

#[tauri::command]
pub async fn ssh_delete_host(app: tauri::AppHandle, id: String) -> Result<(), String> {
    validate_host_id(&id)?;
    let store = host_store();
    if !store.remove(&id) {
        return Err(format!("unknown SSH host: {id}"));
    }
    store.persist(&app)?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_bind_space(
    app: tauri::AppHandle,
    id: String,
    space_id: Option<String>,
) -> Result<(), String> {
    validate_host_id(&id)?;
    let store = host_store();
    let mut host = store.get(&id).ok_or_else(|| format!("unknown SSH host: {id}"))?;
    host.bound_space_id = space_id;
    host.updated_at_ms = now_ms();
    store.upsert(host);
    store.persist(&app)?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_test(app: tauri::AppHandle, id: String) -> Result<String, String> {
    validate_host_id(&id)?;
    let store = host_store();
    store.load(&app);
    let host = store.get(&id).ok_or_else(|| format!("unknown SSH host: {id}"))?;
    probe_auth(&host).map_err(err)?;
    ssh_home(&host).map_err(err)
}

#[tauri::command]
pub async fn ssh_import_config() -> Result<Vec<ImportedHost>, String> {
    let path = dirs::home_dir()
        .ok_or_else(|| "could not resolve home directory".to_string())?
        .join(".ssh")
        .join("config");
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(parse_ssh_config(&text))
}

#[tauri::command]
pub async fn ssh_import_host(
    app: tauri::AppHandle,
    alias: String,
    user: Option<String>,
) -> Result<SshHost, String> {
    let imported = ssh_import_config()
        .await?
        .into_iter()
        .find(|h| h.alias == alias)
        .ok_or_else(|| format!("host not found in ssh config: {alias}"))?;
    let default_user = user
        .filter(|u| !u.trim().is_empty())
        .or_else(|| {
            std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .ok()
        })
        .unwrap_or_else(|| "root".to_string());
    let fields = imported_to_fields(&imported, default_user.trim());
    ssh_save_host(app, SshHostInput {
        id: None,
        alias: fields.alias,
        user: fields.user,
        hostname: fields.hostname,
        port: Some(fields.port),
        identity_file: fields.identity_file,
        remote_root: None,
        color: None,
        agent_forward: Some(false),
    })
    .await
}

#[tauri::command]
pub async fn ssh_host_key_status(
    hostname: String,
    port: Option<u16>,
) -> Result<super::known_hosts::HostKeyStatus, String> {
    let hostname = hostname.trim().to_string();
    if hostname.is_empty() || hostname.len() > 253 {
        return Err("hostname is invalid".into());
    }
    host_key_status(&hostname, port.unwrap_or(22)).map_err(err)
}

#[tauri::command]
pub async fn ssh_scan_host_keys(
    hostname: String,
    port: Option<u16>,
) -> Result<Vec<ScannedKey>, String> {
    let hostname = hostname.trim().to_string();
    if hostname.is_empty() || hostname.len() > 253 {
        return Err("hostname is invalid".into());
    }
    scan_host_keys(&hostname, port.unwrap_or(22)).map_err(err)
}

#[tauri::command]
pub async fn ssh_known_hosts_path() -> Result<Option<String>, String> {
    Ok(default_known_hosts_path())
}

#[tauri::command]
pub async fn ssh_home_for(app: tauri::AppHandle, id: String) -> Result<String, String> {
    validate_host_id(&id)?;
    let store = host_store();
    store.load(&app);
    let host = store.get(&id).ok_or_else(|| format!("unknown SSH host: {id}"))?;
    ssh_home(&host).map_err(err)
}

#[tauri::command]
pub async fn ssh_login_shell_for(app: tauri::AppHandle, id: String) -> Result<String, String> {
    validate_host_id(&id)?;
    let store = host_store();
    store.load(&app);
    let host = store.get(&id).ok_or_else(|| format!("unknown SSH host: {id}"))?;
    ssh_login_shell(&host).map_err(err)
}

/// List zellij sessions on a remote host. A one-shot BatchMode capture:
/// the host must already be reachable (key auth / agent), same as the
/// other SSH probes. `available: false` means zellij is not installed.
#[tauri::command]
pub async fn zellij_sessions(id: String) -> Result<super::zellij::ZellijSessions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = super::integration::host_by_id(&id)?;
        super::zellij::list_sessions(&host)
    })
    .await
    .map_err(|e| format!("zellij_sessions join failed: {e}"))?
}

/// Rename a zellij session. Aimed at `from` through zellij's global
/// `--session` flag, so it never renames whichever session happens to be
/// current. Both names are validated before they reach the remote argv.
#[tauri::command]
pub async fn zellij_rename_session(id: String, from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = super::integration::host_by_id(&id)?;
        super::zellij::rename_session(&host, &from, &to)
    })
    .await
    .map_err(|e| format!("zellij_rename_session join failed: {e}"))?
}

/// Stop a zellij session but leave it on disk for `attach` to resurrect.
#[tauri::command]
pub async fn zellij_kill_session(id: String, session: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = super::integration::host_by_id(&id)?;
        super::zellij::kill_session(&host, &session)
    })
    .await
    .map_err(|e| format!("zellij_kill_session join failed: {e}"))?
}

/// Remove a zellij session permanently (force-killed first when running).
#[tauri::command]
pub async fn zellij_delete_session(id: String, session: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = super::integration::host_by_id(&id)?;
        super::zellij::delete_session(&host, &session)
    })
    .await
    .map_err(|e| format!("zellij_delete_session join failed: {e}"))?
}

#[tauri::command]
pub async fn zellij_kill_all_sessions(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = super::integration::host_by_id(&id)?;
        super::zellij::kill_all_sessions(&host)
    })
    .await
    .map_err(|e| format!("zellij_kill_all_sessions join failed: {e}"))?
}

#[tauri::command]
pub async fn zellij_delete_all_sessions(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = super::integration::host_by_id(&id)?;
        super::zellij::delete_all_sessions(&host)
    })
    .await
    .map_err(|e| format!("zellij_delete_all_sessions join failed: {e}"))?
}

#[tauri::command]
pub async fn ssh_probe_auth(app: tauri::AppHandle, id: String) -> Result<ProbeOutcome, String> {
    validate_host_id(&id)?;
    let store = host_store();
    store.load(&app);
    let host = store.get(&id).ok_or_else(|| format!("unknown SSH host: {id}"))?;
    match probe_auth(&host) {
        Ok(()) => Ok(ProbeOutcome::ok()),
        Err(SshError::AuthRequired { message, hint }) => Ok(ProbeOutcome::auth(message, hint)),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

impl ProbeOutcome {
    fn ok() -> Self {
        Self {
            ok: true,
            message: None,
            next: None,
        }
    }

    fn auth(message: String, hint: AuthHint) -> Self {
        let next = match hint {
            AuthHint::PublicKeyDenied => "key",
            AuthHint::PasswordRequired => "password",
            AuthHint::KeyboardInteractive => "terminal-2fa",
        }
        .to_string();
        Self {
            ok: false,
            message: Some(message),
            next: Some(next),
        }
    }
}

pub struct SshShared {
    pub rpc: std::sync::Arc<super::rpc::SshRpcManager>,
    /// Serializes agent ensure+upload per host: parallel first-use calls
    /// (explorer + git + status bar) must not race duplicate uploads.
    ensure_lock: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// Per-host session cache: avoids re-probing facts that cannot change
    /// within an app run. Every entry here saves at least one full `ssh`
    /// handshake (200ms-2s) on the hot path. Note: ControlMaster is NOT
    /// available on this platform (Windows OpenSSH has no ControlPath
    /// support: `getsockname failed: Not a socket`), so caching probe
    /// results is the only connection-reuse lever we have. Spawn paths
    /// (PTY integration install) read these too.
    pub session: std::sync::Arc<SessionCache>,
}

/// Facts about a host that are stable for the lifetime of the app process:
/// agent binary version match, remote home dir, remote login shell.
#[derive(Clone, Default)]
pub struct HostSessionFacts {
    /// Agent binary at ~/.cache/terax/terax-remote already verified to
    /// match REMOTE_AGENT_VERSION this session (version probe skipped).
    pub agent_verified: bool,
    /// Cached remote $HOME (avoids ssh_home spawn per call).
    pub home: Option<String>,
    /// Cached remote login shell (avoids ssh_login_shell spawn per call).
    pub login_shell: Option<String>,
}

#[derive(Default)]
pub struct SessionCache {
    facts: std::sync::Mutex<std::collections::HashMap<String, HostSessionFacts>>,
}

impl SessionCache {
    pub fn get(&self, host_id: &str) -> HostSessionFacts {
        self.facts.lock().unwrap().get(host_id).cloned().unwrap_or_default()
    }

    pub fn update(&self, host_id: &str, f: impl FnOnce(&mut HostSessionFacts)) {
        let mut map = self.facts.lock().unwrap();
        let entry = map.entry(host_id.to_string()).or_default();
        f(entry);
    }

    pub fn mark_agent_verified(&self, host_id: &str) {
        self.update(host_id, |f| f.agent_verified = true);
    }

    pub fn invalidate_host(&self, host_id: &str) {
        self.facts.lock().unwrap().remove(host_id);
    }
}

impl Default for SshShared {
    fn default() -> Self {
        Self {
            rpc: std::sync::Arc::new(super::rpc::SshRpcManager::default()),
            ensure_lock: std::sync::Arc::new(std::sync::Mutex::new(
                std::collections::HashSet::new(),
            )),
            session: std::sync::Arc::new(SessionCache::default()),
        }
    }
}

/// Version reported by the bundled agent binary. The remote must match or
/// the RPC channel is refused: mixed versions corrupt the method contract.
///
/// This is the app version only for display/logging; the compatibility gate
/// is the remote protocol tag (see `remote_agent_matches`). The app version
/// alone let a stale pre-v3 agent satisfy the reuse check, because the v3
/// wire change did not move the crate version.
pub const REMOTE_AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// RAII per-host serialization for agent ensure. Concurrent first-use
/// ssh_rpc calls for one host queue here; the losers re-check the version
/// after the winner's upload and skip their own.
struct HoldEnsure<'a> {
    set: &'a std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    host_id: String,
}

impl<'a> HoldEnsure<'a> {
    fn acquire(
        set: &'a std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
        host_id: &str,
    ) -> Self {
        loop {
            {
                let mut guard = set.lock().expect("ensure lock poisoned");
                if guard.insert(host_id.to_string()) {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Self {
            set,
            host_id: host_id.to_string(),
        }
    }
}

impl Drop for HoldEnsure<'_> {
    fn drop(&mut self) {
        self.set
            .lock()
            .expect("ensure lock poisoned")
            .remove(&self.host_id);
    }
}

fn bundled_remote_bin() -> Option<std::path::PathBuf> {
    // Dev + release both stage the agent under src-tauri/binaries/.
    let candidates = [
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
        "x86_64-unknown-linux-musl",
        "aarch64-unknown-linux-musl",
    ];
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    candidates
        .iter()
        .map(|t| dir.join(format!("terax-remote-{t}")))
        .find(|p| p.is_file())
}

/// Uploads the bundled agent to `~/.cache/terax/terax-remote` when missing
/// or version-mismatched. Returns the remote path to execute.
///
/// `session` is the per-host cache: when the agent was already verified
/// this app run, the version-probe handshake is skipped entirely.
pub fn ensure_remote_agent(host: &SshHost, session: Option<&SessionCache>) -> Result<String, String> {
    let remote_path = "~/.cache/terax/terax-remote";
    if let Some(cache) = session {
        if cache.get(&host.id).agent_verified {
            return Ok(remote_path.to_string());
        }
    }
    let local = bundled_remote_bin()
        .ok_or_else(|| "remote agent binary not built yet (run pnpm build:remote)".to_string())?;
    // Version check first: reuse the installed agent when it matches.
    let probe = super::session::run_ssh_capture_version(host, remote_path)?;
    if terax_control_protocol::remote_agent_matches(probe.trim()) {
        if let Some(cache) = session {
            cache.mark_agent_verified(&host.id);
        }
        return Ok(remote_path.to_string());
    }
    super::session::upload_file(host, &local, remote_path)?;
    if let Some(cache) = session {
        cache.mark_agent_verified(&host.id);
    }
    Ok(remote_path.to_string())
}

#[tauri::command]
pub async fn ssh_rpc(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshShared>,
    host_id: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    super::hosts::validate_host_id(&host_id)?;
    let store = host_store();
    store.load(&app);
    let host = store
        .get(&host_id)
        .ok_or_else(|| format!("unknown SSH host: {host_id}"))?;
    // Single source of truth: the protocol registry. Any method not listed
    // in REMOTE_METHODS is rejected before touching the network.
    if !terax_control_protocol::REMOTE_METHODS.contains(&method.as_str()) {
        return Err(format!("remote method not allowed: {method}"));
    }
    // Serialize agent ensure per host: the first fan-out (explorer + git
    // + status bar) fires concurrent ssh_rpc calls, and without this they
    // race duplicate version probes and uploads over separate connections.
    // The second waiter finds the agent already installed and skips upload.
    // Once verified this session, the probe is skipped entirely.
    let remote_bin = {
        let _guard = HoldEnsure::acquire(&state.ensure_lock, &host_id);
        ensure_remote_agent(&host, Some(&state.session))?
    };
    // Resolve the agent root: explicit setting wins, then the in-memory
    // session cache (no ssh spawn), then the persisted host record, else
    // probe the remote home once and remember it everywhere.
    let remote_root = match host.remote_root.clone().filter(|r| !r.is_empty()) {
        Some(root) => {
            state.session.update(&host_id, |f| {
                if f.home.is_none() {
                    f.home = Some(root.clone());
                }
            });
            root
        }
        None => match state.session.get(&host_id).home {
            Some(home) => home,
            None => match super::session::ssh_home(&host) {
                Ok(home) => {
                    state.session.update(&host_id, |f| {
                        f.home = Some(home.clone());
                    });
                    let mut updated = host.clone();
                    updated.remote_root = Some(home.clone());
                    updated.updated_at_ms = now_ms();
                    store.upsert(updated);
                    let _ = store.persist(&app);
                    home
                }
                Err(e) => {
                    return Err(format!("could not resolve remote home: {e}"));
                }
            },
        },
    };
    let params = params.as_object().cloned().unwrap_or_default();
    let params = serde_json::Value::Object(params);
    state
        .rpc
        .request(&host_id, &method, params, &remote_bin, &remote_root)
        .map_err(|e| {
            state.rpc.drop_connection(&host_id);
            e
        })
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: tauri::State<'_, SshShared>,
    host_id: String,
) -> Result<(), String> {
    super::hosts::validate_host_id(&host_id)?;
    state.rpc.drop_connection(&host_id);
    // Drop cached session facts too: a disconnect means the next use must
    // re-verify the agent and re-resolve home/shell against a live host.
    state.session.invalidate_host(&host_id);
    Ok(())
}

pub fn classify_for_ui(stderr: &str) -> String {
    classify_probe_output(stderr).to_string()
}
