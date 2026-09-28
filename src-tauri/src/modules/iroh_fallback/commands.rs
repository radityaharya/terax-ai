use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use serde::Serialize;

use crate::modules::ssh::commands::{ssh_rpc_call, SshShared};
use crate::modules::ssh::hosts::{host_store, now_ms, validate_host_id, validate_iroh_endpoint_id};

use super::config::{self, IrohConfig};
use super::rpc::IrohRpcManager;

/// Keychain service name for iroh secrets, stored via the existing
/// `secrets_*` commands exactly like `ssh:<host-id>` is documented to store
/// SSH passwords - same mechanism (`keyring` crate on macOS/Windows, a 0600
/// JSON file on Linux), a distinct service string so the two never collide.
pub const IROH_SECRET_SERVICE: &str = "terax-iroh";
/// Keychain account for the fallback token, one per host (the account is
/// the host id). See `read_token`.
const IROH_TOKEN_ACCOUNT_PREFIX: &str = "token:";
/// Keychain account for the n0 Iroh Services project API key. Project-wide,
/// not per-host, so a single fixed account.
pub const IROH_API_KEY_ACCOUNT: &str = "n0-api-key";

fn token_account(host_id: &str) -> String {
    format!("{IROH_TOKEN_ACCOUNT_PREFIX}{host_id}")
}

pub struct IrohShared {
    pub rpc: Arc<IrohRpcManager>,
    /// `None` = memory-only (tests). `Some` persists non-secret transport
    /// config (relay URLs); the API key always lives in the keychain.
    config_path: Option<PathBuf>,
}

impl Default for IrohShared {
    fn default() -> Self {
        Self {
            rpc: Arc::new(IrohRpcManager::default()),
            config_path: None,
        }
    }
}

impl IrohShared {
    /// Production constructor: loads persisted relay config into the manager
    /// and enables persistence on updates.
    pub fn with_persist_path(path: PathBuf) -> Self {
        let cfg = config::load(&path);
        let rpc = Arc::new(IrohRpcManager::default());
        rpc.set_config(cfg);
        Self {
            rpc,
            config_path: Some(path),
        }
    }

    /// Applies `f` to the current config, persists the non-secret part, and
    /// pushes it to the manager (which rebuilds its endpoint). Passwords and
    /// key material are never written here - `api_secret` is `#[serde(skip)]`.
    pub fn update_config(&self, f: impl FnOnce(&mut IrohConfig)) -> Result<(), String> {
        let mut cfg = self.rpc.config();
        f(&mut cfg);
        if let Some(path) = &self.config_path {
            config::save(path, &cfg)?;
        }
        self.rpc.set_config(cfg);
        Ok(())
    }

    fn set_api_secret(&self, secret: Option<String>) {
        self.rpc.set_api_secret(secret);
    }
}

/// Reads a secret for `account` from the OS keychain via the existing
/// generic `secrets_*` commands (same mechanism the AI subsystem uses for
/// provider keys - `src/modules/ai/lib/keyring.ts` on the frontend,
/// `secrets.rs` on the backend), rather than a new storage path.
async fn read_secret(app: &tauri::AppHandle, account: &str) -> Result<Option<String>, String> {
    let state: tauri::State<'_, crate::modules::secrets::SecretsState> =
        tauri::Manager::state(app);
    crate::modules::secrets::secrets_get(
        app.clone(),
        state,
        IROH_SECRET_SERVICE.into(),
        account.into(),
    )
    .await
}

async fn write_secret(app: &tauri::AppHandle, account: &str, value: &str) -> Result<(), String> {
    let state: tauri::State<'_, crate::modules::secrets::SecretsState> =
        tauri::Manager::state(app);
    crate::modules::secrets::secrets_set(
        app.clone(),
        state,
        IROH_SECRET_SERVICE.into(),
        account.into(),
        value.into(),
    )
    .await
}

async fn delete_secret(app: &tauri::AppHandle, account: &str) -> Result<(), String> {
    let state: tauri::State<'_, crate::modules::secrets::SecretsState> =
        tauri::Manager::state(app);
    crate::modules::secrets::secrets_delete(
        app.clone(),
        state,
        IROH_SECRET_SERVICE.into(),
        account.into(),
    )
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IrohConfigView {
    pub relay_urls: Vec<String>,
    /// Whether an n0 API key is stored. The key itself is never returned.
    pub api_key_set: bool,
}

#[tauri::command]
pub async fn iroh_get_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, IrohShared>,
) -> Result<IrohConfigView, String> {
    let cfg = state.rpc.config();
    let api_key_set = read_secret(&app, IROH_API_KEY_ACCOUNT)
        .await?
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    Ok(IrohConfigView {
        relay_urls: cfg.relay_urls,
        api_key_set,
    })
}

/// Replaces the custom relay URL list. Each entry must parse as an iroh
/// `RelayUrl`; an empty list restores the mode default (n0 public relays, or
/// n0 authenticated relays when an API key is set).
#[tauri::command]
pub async fn iroh_set_relay_urls(
    state: tauri::State<'_, IrohShared>,
    urls: Vec<String>,
) -> Result<(), String> {
    let cleaned: Vec<String> = urls
        .into_iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();
    for url in &cleaned {
        validate_relay_url(url)?;
    }
    state.update_config(|cfg| cfg.relay_urls = cleaned)
}

/// Stores the n0 Iroh Services project API key in the keychain and applies it
/// immediately (rebuilding the endpoint on the next dial). An empty string
/// clears it.
#[tauri::command]
pub async fn iroh_set_api_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, IrohShared>,
    secret: String,
) -> Result<(), String> {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        delete_secret(&app, IROH_API_KEY_ACCOUNT).await?;
        state.set_api_secret(None);
    } else {
        write_secret(&app, IROH_API_KEY_ACCOUNT, trimmed).await?;
        state.set_api_secret(Some(trimmed.to_string()));
    }
    Ok(())
}

#[tauri::command]
pub async fn iroh_clear_api_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, IrohShared>,
) -> Result<(), String> {
    delete_secret(&app, IROH_API_KEY_ACCOUNT).await?;
    state.set_api_secret(None);
    Ok(())
}

/// Validates a relay URL without constructing a config, so the settings UI
/// can reject bad input before saving. Kept as a command so the parsing rules
/// (iroh's own `RelayUrl`) live in exactly one place.
pub fn validate_relay_url(url: &str) -> Result<(), String> {
    iroh::RelayUrl::from_str(url)
        .map(|_| ())
        .map_err(|e| format!("invalid relay url {url:?}: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IrohBootstrapResult {
    pub endpoint_id: String,
    /// Short fingerprint for the pairing dialog (first 16 hex chars of the
    /// endpoint id) - matches the SSH TOFU dialog's fingerprint-only
    /// display, never the full raw key.
    pub fingerprint: String,
    /// True when the host was already pinned to this exact endpoint id
    /// (e.g. bootstrap re-run after the daemon was already armed): the
    /// frontend can skip the confirmation dialog in that case.
    pub already_pinned: bool,
}

/// Step 1 of pairing: drives the existing SSH RPC channel to arm the iroh
/// fallback on the host (generate/load identity + token, write the transport
/// config, ensure the detached daemon is running - see
/// `terax-remote::iroh_fallback::bootstrap`), stores the returned token in
/// the keychain, and returns the endpoint id for the frontend to show in a
/// confirmation dialog. Does **not** pin the host yet: `iroh_confirm_pin`
/// does that, only after explicit user confirmation, mirroring the SSH
/// host-key TOFU flow.
#[tauri::command]
pub async fn iroh_setup_host(
    app: tauri::AppHandle,
    ssh_state: tauri::State<'_, SshShared>,
    iroh_state: tauri::State<'_, IrohShared>,
    host_id: String,
) -> Result<IrohBootstrapResult, String> {
    validate_host_id(&host_id)?;
    let store = host_store();
    store.load(&app);
    let host = store
        .get(&host_id)
        .ok_or_else(|| format!("unknown SSH host: {host_id}"))?;

    // Push the current transport config (relay URLs + API key) to the agent
    // over the already-authenticated SSH channel, so both sides are homed on
    // the same relays. Absent fields leave the remote config untouched.
    let cfg = iroh_state.rpc.config();
    let api_secret = read_secret(&app, IROH_API_KEY_ACCOUNT).await?;
    let mut params = serde_json::json!({ "relayUrls": cfg.relay_urls });
    if let Some(secret) = api_secret.filter(|s| !s.trim().is_empty()) {
        params["apiSecret"] = serde_json::json!(secret);
    }

    let result = ssh_rpc_call(
        &app,
        &ssh_state,
        &host_id,
        terax_control_protocol::REMOTE_METHOD_IROH_BOOTSTRAP,
        params,
    )
    .await?;
    let endpoint_id = result
        .get("endpointId")
        .and_then(serde_json::Value::as_str)
        .ok_or("iroh_bootstrap response missing endpointId")?
        .to_string();
    validate_iroh_endpoint_id(&endpoint_id)?;
    let token = result
        .get("token")
        .and_then(serde_json::Value::as_str)
        .ok_or("iroh_bootstrap response missing token")?
        .to_string();
    write_secret(&app, &token_account(&host_id), &token).await?;
    let already_pinned = host.iroh_endpoint_id.as_deref() == Some(endpoint_id.as_str());
    Ok(IrohBootstrapResult {
        fingerprint: endpoint_id.chars().take(16).collect(),
        endpoint_id,
        already_pinned,
    })
}

/// Step 2 of pairing: the user has seen the fingerprint and explicitly
/// confirmed it. This is the moment Terax itself writes the trust pin -
/// unlike SSH host keys, which the real `ssh` binary writes to
/// `~/.ssh/known_hosts` on the desktop's behalf, there is no OS-level trust
/// store for iroh identities, so `SshHost.irohEndpointId` *is* the pin.
#[tauri::command]
pub async fn iroh_confirm_pin(
    app: tauri::AppHandle,
    host_id: String,
    endpoint_id: String,
) -> Result<(), String> {
    validate_host_id(&host_id)?;
    validate_iroh_endpoint_id(&endpoint_id)?;
    let store = host_store();
    store.load(&app);
    let mut host = store
        .get(&host_id)
        .ok_or_else(|| format!("unknown SSH host: {host_id}"))?;
    host.iroh_endpoint_id = Some(endpoint_id);
    host.updated_at_ms = now_ms();
    store.upsert(host);
    store.persist(&app)
}

/// Clears the pin and the stored token, and drops any live iroh connection
/// for the host. The armed daemon on the remote host is left running
/// (harmless: it answers only token-authenticated requests, and the token
/// stored on the remote is orphaned but never reused since a fresh
/// `iroh_setup_host` regenerates it only if the remote's own token file is
/// also removed, which this command has no reach to do without a live
/// channel).
#[tauri::command]
pub async fn iroh_disable(
    app: tauri::AppHandle,
    iroh_state: tauri::State<'_, IrohShared>,
    host_id: String,
) -> Result<(), String> {
    validate_host_id(&host_id)?;
    let store = host_store();
    store.load(&app);
    let mut host = store
        .get(&host_id)
        .ok_or_else(|| format!("unknown SSH host: {host_id}"))?;
    host.iroh_endpoint_id = None;
    host.updated_at_ms = now_ms();
    store.upsert(host);
    store.persist(&app)?;
    iroh_state.rpc.drop_connection(&host_id);
    delete_secret(&app, &token_account(&host_id)).await
}

/// Attempts one allow-listed remote call over the iroh fallback for a host
/// that already has a pinned endpoint id and stored token. Returns `Err` if
/// the host has no fallback armed (`iroh_endpoint_id` unset) so callers
/// (`ssh::commands::ssh_rpc`) can distinguish "not configured" from "dial
/// failed" and decide whether falling back here even makes sense.
pub async fn iroh_rpc_call(
    app: &tauri::AppHandle,
    iroh_state: &IrohShared,
    host_id: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    validate_host_id(host_id)?;
    if !terax_control_protocol::REMOTE_METHODS.contains(&method) {
        return Err(format!("remote method not allowed: {method}"));
    }
    let store = host_store();
    store.load(app);
    let host = store
        .get(host_id)
        .ok_or_else(|| format!("unknown SSH host: {host_id}"))?;
    let endpoint_id = host
        .iroh_endpoint_id
        .ok_or_else(|| "iroh fallback is not configured for this host".to_string())?;
    let token = read_secret(app, &token_account(host_id))
        .await?
        .ok_or_else(|| "no iroh fallback token stored for this host".to_string())?;
    iroh_state
        .rpc
        .request(host_id, &endpoint_id, &token, method, params)
        .await
}
