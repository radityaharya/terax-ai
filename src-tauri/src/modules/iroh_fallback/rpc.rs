//! Desktop-side iroh RPC client: dials a pinned host EndpointId and speaks
//! the same `ControlRequest`/`ControlResponse` JSON envelope the SSH RPC
//! pipe uses (`ssh::rpc::SshRpcManager`), one request per QUIC bidi stream
//! instead of one line per pipe write - see
//! `terax-remote::iroh_fallback::handle_stream` for the agent side.
//!
//! Only ever dials hosts with a pinned `iroh_endpoint_id`
//! (`ssh::hosts::SshHost`); the pin is the TOFU-style trust anchor learned
//! once over SSH (`iroh_confirm_pin`). No id-based multiplexing: unlike the
//! long-lived SSH pipe, opening a fresh bidi stream per request is cheap
//! enough on an already-connected iroh `Connection` that a dispatch table
//! buys nothing here.
//!
//! Transport config (custom relays / n0 API key) mirrors the agent's
//! `terax-remote::iroh_fallback::build_endpoint`; both sides must agree on
//! which relays they are homed on for the dial to succeed.

use std::collections::{BTreeSet, HashMap};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use iroh::endpoint::{presets, Connection, RelayMode};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl, TransportAddr};
use serde_json::Value;

use super::config::IrohConfig;

const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

fn request_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("iroh-{}-{nanos}-{seq}", std::process::id())
}

fn parse_relay_urls(urls: &[String]) -> Result<BTreeSet<TransportAddr>, String> {
    urls.iter()
        .map(|u| {
            RelayUrl::from_str(u)
                .map(TransportAddr::Relay)
                .map_err(|e| format!("invalid relay url {u:?}: {e}"))
        })
        .collect()
}

/// Builds the desktop's dialing endpoint from the configured transport.
/// Mirrors the agent's mode selection exactly so both land on the same
/// relays; without a persistent identity on this side (only the agent's is
/// pinned), the endpoint key is regenerated per process.
async fn build_endpoint(cfg: &IrohConfig) -> Result<Endpoint, String> {
    if let Some(secret) = cfg.api_secret.as_deref().filter(|s| !s.is_empty()) {
        let mut preset = iroh_services::preset();
        if !cfg.relay_urls.is_empty() {
            preset = preset
                .relays(cfg.relay_urls.iter().map(String::as_str))
                .map_err(|e| e.to_string())?;
        }
        let preset = preset
            .api_secret_from_str(secret)
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())?;
        return Endpoint::bind(preset)
            .await
            .map_err(|e| format!("bind iroh endpoint (services): {e}"));
    }
    if !cfg.relay_urls.is_empty() {
        let relays = parse_relay_urls(&cfg.relay_urls)?;
        let urls: Vec<RelayUrl> = relays
            .iter()
            .filter_map(|a| match a {
                TransportAddr::Relay(u) => Some(u.clone()),
                _ => None,
            })
            .collect();
        return Endpoint::builder(presets::N0)
            .clear_address_lookup()
            .relay_mode(RelayMode::custom(urls))
            .bind()
            .await
            .map_err(|e| format!("bind iroh endpoint (custom relay): {e}"));
    }
    Endpoint::bind(presets::N0)
        .await
        .map_err(|e| format!("bind iroh endpoint: {e}"))
}

/// One shared iroh `Endpoint` for the whole app process (iroh's own
/// recommended usage - not one per host, so all fallback connections share
/// the same relay/NAT-traversal state) plus a per-host cache of live
/// connections, keyed by host id the same way `SshRpcManager` keys its
/// pipes.
#[derive(Default)]
pub struct IrohRpcManager {
    endpoint: Mutex<Option<Endpoint>>,
    connections: Mutex<HashMap<String, Connection>>,
    config: Mutex<IrohConfig>,
}

impl IrohRpcManager {
    pub fn config(&self) -> IrohConfig {
        self.config.lock().unwrap().clone()
    }

    /// Replaces the transport config and invalidates everything derived from
    /// it: the cached endpoint (rebuilt on next dial) and every live
    /// connection (which was established over the old relays).
    pub fn set_config(&self, cfg: IrohConfig) {
        *self.config.lock().unwrap() = cfg;
        *self.endpoint.lock().unwrap() = None;
        self.drop_all_connections();
    }

    /// Updates just the API key (kept out of the persisted config).
    pub fn set_api_secret(&self, secret: Option<String>) {
        {
            let mut cfg = self.config.lock().unwrap();
            cfg.api_secret = secret.filter(|s| !s.trim().is_empty());
        }
        *self.endpoint.lock().unwrap() = None;
        self.drop_all_connections();
    }

    fn drop_all_connections(&self) {
        let drained: Vec<Connection> = self
            .connections
            .lock()
            .unwrap()
            .drain()
            .map(|(_, c)| c)
            .collect();
        for conn in drained {
            conn.close(0u32.into(), b"config changed");
        }
    }

    async fn endpoint(&self) -> Result<Endpoint, String> {
        if let Some(ep) = self.endpoint.lock().unwrap().clone() {
            return Ok(ep);
        }
        let cfg = self.config();
        let ep = build_endpoint(&cfg).await?;
        let mut guard = self.endpoint.lock().unwrap();
        // Another dial may have won the race and stored an endpoint already.
        if guard.is_none() {
            *guard = Some(ep.clone());
        }
        Ok(guard.clone().unwrap_or(ep))
    }

    fn cached_connection(&self, host_id: &str) -> Option<Connection> {
        let conns = self.connections.lock().unwrap();
        let conn = conns.get(host_id)?;
        if conn.close_reason().is_some() {
            return None;
        }
        Some(conn.clone())
    }

    pub fn drop_connection(&self, host_id: &str) {
        if let Some(conn) = self.connections.lock().unwrap().remove(host_id) {
            conn.close(0u32.into(), b"disconnect");
        }
    }

    async fn connection(&self, host_id: &str, endpoint_id_hex: &str) -> Result<Connection, String> {
        if let Some(conn) = self.cached_connection(host_id) {
            return Ok(conn);
        }
        let endpoint = self.endpoint().await?;
        let endpoint_id = EndpointId::from_str(endpoint_id_hex)
            .map_err(|e| format!("invalid pinned iroh endpoint id: {e}"))?;
        // With custom relays, address lookup is disabled, so the relay
        // address must be supplied explicitly (it is the only way to find
        // the peer). With the n0 default, dial by id and let n0 DNS resolve.
        let cfg = self.config();
        let addr = if cfg.relay_urls.is_empty() {
            EndpointAddr::from(endpoint_id)
        } else {
            EndpointAddr {
                id: endpoint_id,
                addrs: parse_relay_urls(&cfg.relay_urls)?,
            }
        };
        let connect = endpoint.connect(addr, terax_control_protocol::IROH_ALPN);
        let conn = tokio::time::timeout(CONNECT_TIMEOUT, connect)
            .await
            .map_err(|_| "iroh connect timed out".to_string())?
            .map_err(|e| format!("iroh connect failed: {e}"))?;
        self.connections
            .lock()
            .unwrap()
            .insert(host_id.to_string(), conn.clone());
        Ok(conn)
    }

    /// Sends one `ControlRequest` over a fresh bidi stream on the host's
    /// (possibly freshly dialed) connection and waits for the matching
    /// `ControlResponse`. A dead cached connection is transparently
    /// replaced by a fresh dial.
    pub async fn request(
        &self,
        host_id: &str,
        endpoint_id_hex: &str,
        token: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let conn = self.connection(host_id, endpoint_id_hex).await?;
        match self.call(&conn, token, method, params.clone()).await {
            Ok(v) => Ok(v),
            Err(_) => {
                // The cached connection may have died between cache-hit and
                // use (e.g. peer restarted); drop it and retry once with a
                // fresh dial rather than surfacing a stale-connection error.
                self.drop_connection(host_id);
                let conn = self.connection(host_id, endpoint_id_hex).await?;
                self.call(&conn, token, method, params).await
            }
        }
    }

    async fn call(
        &self,
        conn: &Connection,
        token: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let id = request_id();
        let envelope = serde_json::json!({
            "protocol": terax_control_protocol::REMOTE_PROTOCOL_VERSION,
            "id": id,
            "token": token,
            "method": method,
            "params": params,
        });
        let mut bytes = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let (mut send, mut recv) = tokio::time::timeout(RPC_TIMEOUT, conn.open_bi())
            .await
            .map_err(|_| "iroh open_bi timed out".to_string())?
            .map_err(|e| format!("iroh open_bi failed: {e}"))?;
        send.write_all(&bytes).await.map_err(|e| e.to_string())?;
        send.finish().map_err(|e| e.to_string())?;
        let response_bytes = tokio::time::timeout(
            RPC_TIMEOUT,
            recv.read_to_end(terax_control_protocol::IROH_MAX_FRAME_BYTES),
        )
        .await
        .map_err(|_| "iroh response timed out".to_string())?
        .map_err(|e| format!("iroh read response failed: {e}"))?;
        let response: Value = serde_json::from_slice(&response_bytes).map_err(|e| e.to_string())?;
        if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
        let err = response
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("remote request failed");
        Err(err.to_string())
    }
}
