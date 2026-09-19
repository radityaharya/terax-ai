use super::config::{parse_ssh_config, ImportedHost};
use super::errors::{classify_probe_output, AuthHint, SshError};
use super::hosts::{
    host_id_for, host_store, imported_to_fields, normalize_host_input, now_ms, validate_host_id,
    SshHost, SshHostInput,
};
use super::known_hosts::{default_known_hosts_path, host_key_status, scan_host_keys, ScannedKey};
use super::session::{probe_auth, ssh_home, ssh_login_shell, MasterRegistry, ProbeCache};

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
    pub masters: std::sync::Arc<MasterRegistry>,
    pub probes: std::sync::Arc<ProbeCache>,
    pub rpc: std::sync::Arc<super::rpc::SshRpcManager>,
}

impl Default for SshShared {
    fn default() -> Self {
        Self {
            masters: std::sync::Arc::new(MasterRegistry::default()),
            probes: std::sync::Arc::new(ProbeCache::default()),
            rpc: std::sync::Arc::new(super::rpc::SshRpcManager::default()),
        }
    }
}

/// Version reported by the bundled agent binary. The remote must match or
/// the RPC channel is refused: mixed versions corrupt the method contract.
pub const REMOTE_AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

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
pub fn ensure_remote_agent(host: &SshHost) -> Result<String, String> {
    let local = bundled_remote_bin()
        .ok_or_else(|| "remote agent binary not built yet (run pnpm build:remote)".to_string())?;
    let remote_path = "~/.cache/terax/terax-remote";
    // Version check first: reuse the installed agent when it matches.
    let probe = super::session::run_ssh_capture_version(host, &format!("{remote_path} --version"))?;
    if probe.trim().ends_with(REMOTE_AGENT_VERSION) {
        return Ok(remote_path.to_string());
    }
    super::session::upload_file(host, &local, remote_path)?;
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
    let allowed = [
        "fs_read_dir",
        "fs_read_file",
        "fs_write_file",
        "fs_stat",
        "fs_search",
        "fs_grep",
        "fs_create_file",
        "fs_create_dir",
        "fs_rename",
        "fs_delete",
        "fs_delete_batch",
        "fs_move",
        "fs_copy",
        "git_panel_snapshot",
        "git_status",
        "git_resolve_repo",
        "git_diff",
        "git_diff_content",
        "git_stage",
        "git_unstage",
        "git_discard",
        "git_commit",
        "git_log",
        "git_show_commit",
        "git_commit_files",
        "git_commit_file_diff",
        "git_remote_url",
        "git_fetch",
        "git_pull_ff_only",
        "git_push",
        "git_list_branches",
        "git_checkout_branch",
        "shell_run",
        "shell_session_open",
        "shell_session_run",
        "shell_session_close",
        "shell_bg_spawn",
        "shell_bg_logs",
        "shell_bg_kill",
        "ping",
        "capabilities",
    ];
    if !allowed.contains(&method.as_str()) {
        return Err(format!("remote method not allowed: {method}"));
    }
    let remote_bin = ensure_remote_agent(&host)?;
    // Resolve the agent root: explicit setting wins, else probe the remote
    // home once and remember it on the host so later calls skip the probe.
    let remote_root = match host.remote_root.clone().filter(|r| !r.is_empty()) {
        Some(root) => root,
        None => match super::session::ssh_home(&host) {
            Ok(home) => {
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
    Ok(())
}

pub fn classify_for_ui(stderr: &str) -> String {
    classify_probe_output(stderr).to_string()
}
