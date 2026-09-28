//! Iroh P2P fallback transport for `terax-remote`.
//!
//! SSH stays the only first-contact channel: the desktop never dials a host
//! over iroh it has not already reached over SSH at least once. The
//! `iroh_bootstrap` remote method (dispatched from `main.rs::route`, still
//! running as the short-lived SSH-child `Agent`) generates or loads a
//! persistent iroh identity and a fallback-channel token, then ensures a
//! detached `terax-remote iroh-serve --root <dir>` daemon is listening
//! independently of the SSH channel that spawned it. That daemon builds its
//! own `Agent` (see `build_agent` in `main.rs`) and answers the exact same
//! `ControlRequest`/`ControlResponse` JSON envelope the SSH RPC pipe uses,
//! one request per iroh QUIC bidi stream instead of one line per pipe write.
//!
//! No systemd unit, no reboot survival: a crashed or rebooted host stops
//! answering iroh requests until the next successful SSH connect re-arms the
//! daemon via `iroh_bootstrap`. This is a deliberate, scoped v1 limitation.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use iroh::endpoint::{presets, RelayMode};
use iroh::{Endpoint, RelayUrl, SecretKey};
use serde::Serialize;

use crate::Agent;

const IDENTITY_FILE: &str = "iroh-identity";
const TOKEN_FILE: &str = "terax-iroh-token";
const PID_FILE: &str = "terax-iroh.pid";
/// n0 Iroh Services project API key, 0600. Empty/absent means "use public
/// relays" (or, when `RELAYS_FILE` is set, an unauthenticated custom relay).
const API_KEY_FILE: &str = "iroh-api-key";
/// JSON array of custom relay URLs, 0600. Empty/absent means "use the n0
/// default relay set for the chosen mode". Set together with no API key for
/// a fully self-hosted, n0-independent deployment.
const RELAYS_FILE: &str = "iroh-relays.json";

/// Directory holding the persistent identity, token, and pidfile. Overridable
/// via `TERAX_IROH_CACHE_DIR` so tests never touch the real home directory.
fn cache_dir() -> Result<PathBuf, String> {
    let dir = match std::env::var("TERAX_IROH_CACHE_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => dirs::home_dir()
            .ok_or_else(|| "cannot resolve home directory".to_string())?
            .join(".cache")
            .join("terax"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("create cache dir {}: {e}", dir.display()))?;
    Ok(dir)
}

fn identity_path() -> Result<PathBuf, String> {
    Ok(cache_dir()?.join(IDENTITY_FILE))
}

fn token_path() -> Result<PathBuf, String> {
    Ok(cache_dir()?.join(TOKEN_FILE))
}

fn pid_path() -> Result<PathBuf, String> {
    Ok(cache_dir()?.join(PID_FILE))
}

/// Writes `bytes` to `path` via a same-directory temp file plus atomic
/// rename, `0600` on unix. Mirrors the desktop-side atomic write pattern
/// used for host/facts stores (`hosts.rs`, `commands.rs::SessionCache`).
fn write_secret_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        f.write_all(bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

/// Loads the persistent iroh identity, generating one on first use. The same
/// identity must survive daemon restarts so an EndpointID pinned once (over
/// SSH, TOFU-style) keeps resolving to this host.
fn load_or_create_secret_key() -> Result<SecretKey, String> {
    let path = identity_path()?;
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(SecretKey::from_bytes(&arr));
        }
    }
    let key = SecretKey::generate();
    write_secret_file(&path, &key.to_bytes())?;
    Ok(key)
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("generate iroh token: {e}"))?;
    let mut token = String::with_capacity(64);
    use std::fmt::Write as _;
    for b in bytes {
        let _ = write!(token, "{b:02x}");
    }
    Ok(token)
}

/// Loads the persistent fallback-channel token, generating one on first use.
/// Separate from the ephemeral per-connection token the SSH RPC channel
/// uses (`auth::expect_token` in the `serve` process): the iroh daemon is a
/// distinct, long-lived process instance with its own `OnceLock`, so reusing
/// the same auth module introduces no conflict, only a different value.
fn load_or_create_token() -> Result<String, String> {
    let path = token_path()?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(trimmed.to_string());
        }
    }
    let token = generate_token()?;
    write_secret_file(&path, token.as_bytes())?;
    Ok(token)
}

/// Transport configuration shared by the agent and (mirrored) the desktop.
/// Both sides must agree: the desktop dials relays the agent is homed on.
#[derive(Clone, Debug, Default)]
pub(crate) struct RuntimeConfig {
    /// n0 Iroh Services project API key. `None`/empty means no n0
    /// authentication (public relays, or a self-hosted relay without auth).
    pub api_secret: Option<String>,
    /// Custom relay URLs. Empty means "use whatever the selected mode
    /// defaults to" (n0 production relays for both public and services
    /// presets).
    pub relay_urls: Vec<String>,
}

/// Loads the runtime config from the cache dir. Missing files are the
/// common (zero-config) case and yield the default.
pub(crate) fn load_runtime_config() -> Result<RuntimeConfig, String> {
    let dir = cache_dir()?;
    let api_secret = std::fs::read_to_string(dir.join(API_KEY_FILE))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let relay_urls = std::fs::read(dir.join(RELAYS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();
    Ok(RuntimeConfig {
        api_secret,
        relay_urls,
    })
}

/// Writes the runtime config supplied over the (already-authenticated) SSH
/// bootstrap call. `None` leaves the existing file untouched; `Some` with an
/// empty value clears it, so "unset credentials" is expressible without a
/// second channel.
fn write_runtime_config(
    api_secret: Option<&str>,
    relay_urls: Option<&[String]>,
) -> Result<(), String> {
    let dir = cache_dir()?;
    if let Some(secret) = api_secret {
        let path = dir.join(API_KEY_FILE);
        let trimmed = secret.trim();
        if trimmed.is_empty() {
            let _ = std::fs::remove_file(&path);
        } else {
            write_secret_file(&path, trimmed.as_bytes())?;
        }
    }
    if let Some(relays) = relay_urls {
        let path = dir.join(RELAYS_FILE);
        let cleaned: Vec<String> = relays
            .iter()
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .collect();
        if cleaned.is_empty() {
            let _ = std::fs::remove_file(&path);
        } else {
            let bytes = serde_json::to_vec(&cleaned).map_err(|e| e.to_string())?;
            write_secret_file(&path, &bytes)?;
        }
    }
    Ok(())
}

fn parse_relay_urls(urls: &[String]) -> Result<Vec<RelayUrl>, String> {
    urls.iter()
        .map(|u| {
            RelayUrl::from_str(u).map_err(|e| format!("invalid relay url {u:?}: {e}"))
        })
        .collect()
}

/// Builds the listener endpoint with the configured transport.
///
/// Three modes, in priority order:
/// 1. API key set: n0 Iroh Services preset (optionally with explicit relays
///    for a dedicated deployment). The key is used locally to mint an
///    endpoint-bound relay token; it is never sent to the relay itself.
/// 2. Custom relays, no API key: plain iroh with `RelayMode::custom` and
///    address lookup disabled, so a self-hosted deployment never talks to
///    n0's DNS. The desktop dials with the relay addresses explicitly.
/// 3. Nothing configured: `presets::N0` - public relays + n0 DNS lookup.
async fn build_endpoint(key: SecretKey, cfg: &RuntimeConfig) -> Result<Endpoint, String> {
    let alpns = vec![terax_control_protocol::IROH_ALPN.to_vec()];
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
        return Endpoint::builder(preset)
            .secret_key(key)
            .alpns(alpns)
            .bind()
            .await
            .map_err(|e| format!("bind iroh endpoint (services): {e}"));
    }
    if !cfg.relay_urls.is_empty() {
        let relays = parse_relay_urls(&cfg.relay_urls)?;
        return Endpoint::builder(presets::N0)
            .clear_address_lookup()
            .relay_mode(RelayMode::custom(relays))
            .secret_key(key)
            .alpns(alpns)
            .bind()
            .await
            .map_err(|e| format!("bind iroh endpoint (custom relay): {e}"));
    }
    Endpoint::builder(presets::N0)
        .secret_key(key)
        .alpns(alpns)
        .bind()
        .await
        .map_err(|e| format!("bind iroh endpoint: {e}"))
}

/// True when the pidfile names a process that still exists. `kill(pid, 0)`
/// sends no signal, only checks existence/permission - the standard
/// liveness probe. A stale pidfile (process gone) reads as not-alive so a
/// fresh daemon gets spawned.
#[cfg(unix)]
fn daemon_alive() -> bool {
    let Ok(path) = pid_path() else { return false };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(pid) = contents.trim().parse::<i32>() else {
        return false;
    };
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Spawns a detached `terax-remote iroh-serve --root <dir>` daemon.
///
/// `Command::spawn` already forks+execs on unix; the only extra step needed
/// to detach the child from the SSH channel's session is `setsid()` in
/// `pre_exec` (runs in the forked child, before exec), plus null stdio so it
/// never blocks on a closed pipe. A full double-fork additionally protects
/// against the daemon ever reacquiring a controlling terminal, which does
/// not apply here since this process never opens a tty - single fork+setsid
/// is the same technique `setsid(1)`/`nohup` use and is sufficient.
///
/// Dropping the returned `Child` does not kill it (only `Child::kill` does):
/// once spawned it is intentionally left to run, orphaned, reparented to
/// init/subreaper on exit.
#[cfg(unix)]
fn spawn_daemon(root: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| format!("resolve current exe: {e}"))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("iroh-serve")
        .arg("--root")
        .arg(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn().map_err(|e| format!("spawn iroh-serve daemon: {e}"))?;
    drop(child);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapInfo {
    pub endpoint_id: String,
    pub token: String,
    pub already_running: bool,
}

/// Signals the daemon named by the pidfile and waits briefly for it to exit.
/// A no-op when no pidfile exists or the process is already gone.
#[cfg(unix)]
fn stop_daemon() {
    let Ok(path) = pid_path() else { return };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(pid) = contents.trim().parse::<i32>() else {
        return;
    };
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(50));
        if unsafe { libc::kill(pid, 0) } != 0 {
            break;
        }
    }
    let _ = std::fs::remove_file(&path);
}

/// Entry point for the `iroh_bootstrap` remote method: ensures an identity,
/// a fallback token, and a live daemon exist for `root`, returning what the
/// desktop needs to pin this host (EndpointID) and authenticate future
/// fallback connections (token).
///
/// `api_secret`/`relay_urls` are `Option` so "leave unchanged" is distinct
/// from "clear": `None` keeps the stored value, `Some("")`/`Some([])` clears
/// it. Supplying either restarts an already-running daemon so it rebinds
/// with the new transport config.
#[cfg(unix)]
pub(crate) fn bootstrap(
    root: &Path,
    api_secret: Option<&str>,
    relay_urls: Option<&[String]>,
) -> Result<BootstrapInfo, String> {
    let key = load_or_create_secret_key()?;
    let token = load_or_create_token()?;
    let config_provided = api_secret.is_some() || relay_urls.is_some();
    if config_provided {
        write_runtime_config(api_secret, relay_urls)?;
    }
    let already_running = daemon_alive() && !config_provided;
    if !already_running {
        if daemon_alive() {
            stop_daemon();
        }
        spawn_daemon(root)?;
    }
    Ok(BootstrapInfo {
        endpoint_id: key.public().to_string(),
        token,
        already_running,
    })
}

#[cfg(not(unix))]
pub(crate) fn bootstrap(
    _root: &Path,
    _api_secret: Option<&str>,
    _relay_urls: Option<&[String]>,
) -> Result<BootstrapInfo, String> {
    Err("iroh fallback is only supported on unix remote hosts".into())
}

fn write_pidfile() -> Result<(), String> {
    let path = pid_path()?;
    std::fs::write(&path, std::process::id().to_string())
        .map_err(|e| format!("write pidfile {}: {e}", path.display()))
}

/// Runs the detached daemon loop: binds one iroh `Endpoint`, accepts
/// connections forever, and answers each request stream by delegating to
/// the same `Agent::handle_line` the SSH RPC pipe uses. Never returns.
#[cfg(unix)]
pub(crate) fn run_foreground(root_arg: String) -> ! {
    let agent = match crate::build_agent(&root_arg) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("iroh-serve: cannot authorize root {root_arg}: {e}");
            std::process::exit(2);
        }
    };
    let key = match load_or_create_secret_key() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("iroh-serve: {e}");
            std::process::exit(2);
        }
    };
    let token = match load_or_create_token() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("iroh-serve: {e}");
            std::process::exit(2);
        }
    };
    crate::auth::expect_token(&token);
    if let Err(e) = write_pidfile() {
        eprintln!("iroh-serve: {e}");
        std::process::exit(2);
    }

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("iroh-serve: failed to build tokio runtime: {e}");
            std::process::exit(1);
        }
    };
    let cfg = match load_runtime_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("iroh-serve: {e}");
            std::process::exit(2);
        }
    };
    let code = rt.block_on(accept_loop(agent, key, cfg));
    std::process::exit(code);
}

#[cfg(unix)]
async fn accept_loop(agent: Arc<Agent>, key: SecretKey, cfg: RuntimeConfig) -> i32 {
    let endpoint = match build_endpoint(key, &cfg).await {
        Ok(ep) => ep,
        Err(e) => {
            eprintln!("iroh-serve: {e}");
            return 2;
        }
    };
    while let Some(incoming) = endpoint.accept().await {
        let agent = agent.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_incoming(incoming, agent).await {
                eprintln!("iroh-serve: connection error: {e}");
            }
        });
    }
    0
}

#[cfg(unix)]
async fn handle_incoming(incoming: iroh::endpoint::Incoming, agent: Arc<Agent>) -> Result<(), String> {
    let connection = incoming.await.map_err(|e| e.to_string())?;
    loop {
        let (send, recv) = match connection.accept_bi().await {
            Ok(streams) => streams,
            Err(_) => break,
        };
        let agent = agent.clone();
        tokio::spawn(async move {
            let _ = handle_stream(send, recv, agent).await;
        });
    }
    Ok(())
}

/// One request per bidi stream: read the sender's single JSON line to
/// completion (the client `finish()`es its send side), route it through the
/// same `handle_line` the SSH pipe uses (JSON parse, protocol check, token
/// check, dispatch), write one JSON line back, and finish the response
/// stream. No id-based multiplexing: unlike the long-lived SSH pipe, iroh
/// streams are cheap enough that one stream per logical request needs no
/// dispatch table.
#[cfg(unix)]
async fn handle_stream(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    agent: Arc<Agent>,
) -> Result<(), String> {
    let bytes = recv
        .read_to_end(terax_control_protocol::IROH_MAX_FRAME_BYTES)
        .await
        .map_err(|e| e.to_string())?;
    let line = String::from_utf8_lossy(&bytes);
    let response = agent.handle_line(line.trim_end());
    let mut out = serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec());
    out.push(b'\n');
    send.write_all(&out).await.map_err(|e| e.to_string())?;
    send.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs `f` with `TERAX_IROH_CACHE_DIR` pointed at a fresh tempdir so
    /// identity/token persistence never touches the real home directory.
    /// Serialized via a mutex: env vars are process-global and these tests
    /// run in parallel by default.
    fn with_temp_cache<T>(f: impl FnOnce(&Path) -> T) -> T {
        use std::sync::Mutex;
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("TERAX_IROH_CACHE_DIR", dir.path());
        let result = f(dir.path());
        std::env::remove_var("TERAX_IROH_CACHE_DIR");
        result
    }

    #[test]
    fn generated_tokens_are_64_hex() {
        let t = generate_token().unwrap();
        assert_eq!(t.len(), 64);
        assert!(t.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn token_persists_across_loads() {
        with_temp_cache(|_dir| {
            let first = load_or_create_token().unwrap();
            let second = load_or_create_token().unwrap();
            assert_eq!(first, second, "second load must reuse the persisted token");
        });
    }

    #[test]
    fn identity_persists_across_loads() {
        with_temp_cache(|_dir| {
            let first = load_or_create_secret_key().unwrap();
            let second = load_or_create_secret_key().unwrap();
            assert_eq!(
                first.public(),
                second.public(),
                "second load must reuse the persisted identity"
            );
        });
    }

    #[test]
    fn secret_file_is_owner_only_on_unix() {
        with_temp_cache(|dir| {
            let _ = load_or_create_token().unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let meta = std::fs::metadata(dir.join(TOKEN_FILE)).unwrap();
                assert_eq!(meta.permissions().mode() & 0o777, 0o600);
            }
        });
    }

    #[test]
    fn runtime_config_round_trips_and_clears() {
        with_temp_cache(|_dir| {
            assert_eq!(load_runtime_config().unwrap().relay_urls.len(), 0);
            assert!(load_runtime_config().unwrap().api_secret.is_none());

            let relays = vec!["https://relay.example.com".to_string()];
            write_runtime_config(Some("  secret-key  "), Some(&relays)).unwrap();
            let loaded = load_runtime_config().unwrap();
            assert_eq!(loaded.api_secret.as_deref(), Some("secret-key"));
            assert_eq!(loaded.relay_urls, relays);
        });
    }

    #[test]
    fn runtime_config_cleared_by_empty_values() {
        with_temp_cache(|_dir| {
            write_runtime_config(Some("k"), Some(&["https://r.example".to_string()])).unwrap();
            write_runtime_config(Some(""), Some(&[])).unwrap();
            let loaded = load_runtime_config().unwrap();
            assert!(loaded.api_secret.is_none());
            assert!(loaded.relay_urls.is_empty());
        });
    }

    #[test]
    fn runtime_config_untouched_when_none() {
        with_temp_cache(|_dir| {
            write_runtime_config(Some("keep-me"), Some(&["https://r.example".to_string()]))
                .unwrap();
            // None means "leave unchanged", distinct from Some("")/Some([]).
            write_runtime_config(None, None).unwrap();
            let loaded = load_runtime_config().unwrap();
            assert_eq!(loaded.api_secret.as_deref(), Some("keep-me"));
            assert_eq!(loaded.relay_urls.len(), 1);
        });
    }

    #[test]
    fn invalid_relay_url_is_rejected() {
        assert!(parse_relay_urls(&["not a url".to_string()]).is_err());
        assert!(parse_relay_urls(&["https://relay.example.com".to_string()]).is_ok());
    }

    #[test]
    fn daemon_alive_is_false_with_no_pidfile() {
        with_temp_cache(|_dir| {
            assert!(!daemon_alive());
        });
    }

    #[test]
    fn daemon_alive_is_false_for_a_dead_pid() {
        with_temp_cache(|dir| {
            // PID 1 always exists on a real Linux host, but a very large,
            // almost-certainly-unused PID lets this assert deterministically
            // without relying on any specific process being dead.
            std::fs::write(dir.join(PID_FILE), "2147483647").unwrap();
            assert!(!daemon_alive());
        });
    }

    #[test]
    fn daemon_alive_is_true_for_own_pid() {
        with_temp_cache(|dir| {
            std::fs::write(dir.join(PID_FILE), std::process::id().to_string()).unwrap();
            assert!(daemon_alive());
        });
    }
}
