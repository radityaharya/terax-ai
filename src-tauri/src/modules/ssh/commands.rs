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
pub async fn ssh_list_hosts() -> Result<Vec<SshHost>, String> {
    Ok(host_store().list())
}

#[tauri::command]
pub async fn ssh_save_host(input: SshHostInput) -> Result<SshHost, String> {
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
    Ok(host)
}

#[tauri::command]
pub async fn ssh_delete_host(id: String) -> Result<(), String> {
    validate_host_id(&id)?;
    if !host_store().remove(&id) {
        return Err(format!("unknown SSH host: {id}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_bind_space(id: String, space_id: Option<String>) -> Result<(), String> {
    validate_host_id(&id)?;
    let store = host_store();
    let mut host = store.get(&id).ok_or_else(|| format!("unknown SSH host: {id}"))?;
    host.bound_space_id = space_id;
    host.updated_at_ms = now_ms();
    store.upsert(host);
    Ok(())
}

#[tauri::command]
pub async fn ssh_test(id: String) -> Result<String, String> {
    validate_host_id(&id)?;
    let host = host_store().get(&id).ok_or_else(|| format!("unknown SSH host: {id}"))?;
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
pub async fn ssh_import_host(alias: String, user: Option<String>) -> Result<SshHost, String> {
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
    ssh_save_host(SshHostInput {
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
pub async fn ssh_home_for(id: String) -> Result<String, String> {
    validate_host_id(&id)?;
    let host = host_store().get(&id).ok_or_else(|| format!("unknown SSH host: {id}"))?;
    ssh_home(&host).map_err(err)
}

#[tauri::command]
pub async fn ssh_login_shell_for(id: String) -> Result<String, String> {
    validate_host_id(&id)?;
    let host = host_store().get(&id).ok_or_else(|| format!("unknown SSH host: {id}"))?;
    ssh_login_shell(&host).map_err(err)
}

#[tauri::command]
pub async fn ssh_probe_auth(id: String) -> Result<ProbeOutcome, String> {
    validate_host_id(&id)?;
    let host = host_store().get(&id).ok_or_else(|| format!("unknown SSH host: {id}"))?;
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
}

impl Default for SshShared {
    fn default() -> Self {
        Self {
            masters: std::sync::Arc::new(MasterRegistry::default()),
            probes: std::sync::Arc::new(ProbeCache::default()),
        }
    }
}

pub fn classify_for_ui(stderr: &str) -> String {
    classify_probe_output(stderr).to_string()
}
