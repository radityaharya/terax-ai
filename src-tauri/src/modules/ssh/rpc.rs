use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::errors::SshError;
use super::hosts::{host_store, validate_host_id};
use super::session::rpc_args;
use crate::modules::proc::hide_console;

const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

struct RpcChild {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
}

struct RpcConnection {
    rpc: Mutex<RpcChild>,
    token: String,
    /// Highest agent protocol the far end advertised (from the ping
    /// handshake). Gates v3 envelope fields like `lane`: never send a v3
    /// field to a v2 agent — unknown fields are ignored today, but version
    /// gating keeps that a deliberate choice per field, not an accident.
    protocol: u16,
}

/// Independent stdio pipes to the same host's agent. The agent protocol
/// is strictly one-request-at-a-time per pipe (single-threaded serve
/// loop), and one Mutex guards that framing per pipe, so unrelated calls
/// (explorer listing dir A, git polling status, preview stating a file)
/// were queueing behind each other on a single pipe. A small pool lets
/// them run concurrently; the remote agent itself is stateless per call
/// (each request carries its full path + token), so any pipe serves any
/// method.
const POOL_SIZE: usize = 4;

pub struct SshRpcManager {
    /// host_id -> up to POOL_SIZE pipes, round-robined per request.
    connections: Mutex<HashMap<String, Vec<Arc<RpcConnection>>>>,
    next_lane: Mutex<HashMap<String, usize>>,
}

impl Default for SshRpcManager {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            next_lane: Mutex::new(HashMap::new()),
        }
    }
}

fn request_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{nanos}-{seq}", std::process::id())
}

fn generate_token() -> Result<String, SshError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| SshError::Io {
        message: format!("generate rpc token: {e}"),
    })?;
    let mut token = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(token, "{b:02x}");
    }
    Ok(token)
}

/// Methods whose agent-side state lives in the serving **process**:
/// background procs (`bg` / `docker.logs` / `docker.events` maps, keyed by
/// numeric handle) and PTY-backed shell sessions. A spawn on lane N must be
/// followed by poll/kill on the same lane or the handle lookup fails with
/// `no_handle`. Every other method is stateless (each request carries its
/// full path + token) and stays on the round-robin pool.
fn is_stateful_method(method: &str) -> bool {
    matches!(
        method,
        "shell_session_open"
            | "shell_session_run"
            | "shell_session_close"
            | "shell_bg_spawn"
            | "shell_bg_logs"
            | "shell_bg_kill"
            | "docker_pull"
            | "docker_logs_spawn"
            | "docker_logs_poll"
            | "docker_logs_kill"
            | "docker_events_spawn"
            | "docker_events_poll"
            | "docker_events_kill"
            | "docker_compose_logs"
            | "docker_service_logs_spawn"
            | "docker_service_logs_poll"
            | "docker_service_logs_kill"
            | "docker_compose_logs_spawn"
            | "docker_compose_logs_poll"
            | "docker_compose_logs_kill"
    )
}

/// Lane reserved for stateful calls. It never advances the round-robin
/// cursor, so stateless traffic cannot steal it mid-sequence and strand a
/// background handle on the wrong agent process.
const STATEFUL_LANE: usize = 0;

/// v3 affinity lanes for stateful namespaces. One u8 tag per follow class:
/// the desktop pins each spawn/poll/kill sequence to its tag, and the agent
/// resolves the tag to an isolated handle map. Tags are stable wire values
/// (do not renumber): future transports relocate namespaces by tag.
pub const AFFINITY_DEFAULT: u8 = 0;
pub const AFFINITY_SHELL_BG: u8 = 1;
pub const AFFINITY_SHELL_SESSION: u8 = 2;
pub const AFFINITY_DOCKER_LOGS: u8 = 3;
pub const AFFINITY_DOCKER_EVENTS: u8 = 4;
pub const AFFINITY_DOCKER_PULL: u8 = 5;
pub const AFFINITY_COMPOSE_LOGS: u8 = 6;

/// Stateful method -> its v3 affinity tag. None = stateless (any pipe
/// serves it; requests carry full params).
fn affinity_for(method: &str) -> Option<u8> {
    Some(match method {
        "shell_bg_spawn" | "shell_bg_logs" | "shell_bg_kill" => AFFINITY_SHELL_BG,
        "shell_session_open" | "shell_session_run" | "shell_session_close" => {
            AFFINITY_SHELL_SESSION
        }
        "docker_logs_spawn" | "docker_logs_poll" | "docker_logs_kill" => AFFINITY_DOCKER_LOGS,
        "docker_events_spawn" | "docker_events_poll" | "docker_events_kill" => {
            AFFINITY_DOCKER_EVENTS
        }
        "docker_pull" => AFFINITY_DOCKER_PULL,
        "docker_compose_logs" | "docker_service_logs_spawn" | "docker_service_logs_poll"
        | "docker_service_logs_kill" | "docker_compose_logs_spawn" | "docker_compose_logs_poll"
        | "docker_compose_logs_kill" => AFFINITY_COMPOSE_LOGS,
        _ => return None,
    })
}

impl SshRpcManager {
    /// Sends a request to the host agent, spawning the channel on first use.
    /// The agent binary path on the remote is resolved at connect time.
    ///
    /// Routing: stateless methods round-robin the pool (any pipe serves
    /// any request). Stateful methods pin to the reserved pipe AND carry
    /// their v3 affinity tag, so the agent resolves them in an isolated
    /// handle namespace. Belt and suspenders: the pin keeps today's
    /// process-local maps correct; the tag keeps it correct when state
    /// moves out-of-process (socket daemon) or when a lane dies and the
    /// pool respawns elsewhere.
    pub fn request(
        &self,
        host_id: &str,
        method: &str,
        params: Value,
        remote_bin: &str,
        remote_root: &str,
    ) -> Result<Value, String> {
        validate_host_id(host_id).map_err(|m| m)?;
        if let Some(affinity) = affinity_for(method) {
            let conn = self.pinned_connection(host_id, remote_bin, remote_root, STATEFUL_LANE)?;
            // Pull procs live in the events map but spawn under the pull
            // tag; poll/kill must resolve the SAME tag or the handle lookup
            // misses. The agent maps AFFINITY_DOCKER_PULL -> events map.
            return self.call_with_lane(&conn, host_id, method, params, Some(affinity));
        }
        let conn = self.connection(host_id, remote_bin, remote_root)?;
        self.call(&conn, host_id, method, params)
    }

    pub fn drop_connection(&self, host_id: &str) {
        if let Some(pool) = self.connections.lock().unwrap().remove(host_id) {
            for conn in pool {
                if let Ok(mut rpc) = conn.rpc.lock() {
                    let _ = rpc.child.kill();
                }
            }
        }
        self.next_lane.lock().unwrap().remove(host_id);
    }

    fn spawn_lane(
        &self,
        host: &super::hosts::SshHost,
        remote_bin: &str,
        remote_root: &str,
    ) -> Result<Arc<RpcConnection>, String> {
        let token = generate_token().map_err(|e| e.to_string())?;
        let remote_cmd = format!("{remote_bin} serve --root {remote_root} --token {token}");
        let args = rpc_args(host, &remote_cmd);
        let mut cmd = Command::new(super::session::ssh_binary());
        for arg in args {
            cmd.arg(arg);
        }
        // rpc_args already includes BatchMode=yes: the agent channel never
        // prompts. Interactive auth happens only via the master flow.
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        hide_console(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("spawn ssh rpc: {e}"))?;
        let stdin = child.stdin.take().ok_or("no rpc stdin")?;
        let stdout = child.stdout.take().ok_or("no rpc stdout")?;
        let mut conn = RpcConnection {
            rpc: Mutex::new(RpcChild {
                child,
                stdin,
                reader: BufReader::new(stdout),
            }),
            token,
            // Pessimistic until the handshake below proves otherwise.
            protocol: 2,
        };
        // Verify the channel before caching: ping must succeed. The ping
        // response carries the agent's protocol version — that gates v3
        // envelope fields (lane affinity) per connection. `conn` is still
        // uniquely owned here (not yet published to the pool), so plain
        // field writes are race-free; wrap in Arc only at the end.
        let staged = Arc::new(conn);
        let ping = self.call_raw(&staged, "ping", serde_json::json!({}))?;
        if !ping.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return Err("remote agent ping failed".into());
        }
        let advertised = ping
            .get("result")
            .and_then(|r| r.get("protocol"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(2) as u16;
        let mut conn = Arc::try_unwrap(staged).map_err(|_| "rpc lane uniquely owned".to_string())?;
        conn.protocol = advertised.max(2);
        Ok(Arc::new(conn))
    }

    /// Round-robin a lane from the host's pool, growing it lazily to
    /// POOL_SIZE. The pool map is only held for the index bookkeeping;
    /// lane spawns (full ssh handshakes) happen outside the map lock so
    /// concurrent first-use calls don't serialize on it.
    fn connection(
        &self,
        host_id: &str,
        remote_bin: &str,
        remote_root: &str,
    ) -> Result<Arc<RpcConnection>, String> {
        let lane = {
            let mut lanes = self.next_lane.lock().unwrap();
            let next = lanes.entry(host_id.to_string()).or_insert(0);
            // The stateful lane is reserved: round-robin skips it so bulk
            // stateless calls never evict the pipe that owns live handles.
            let mut lane = *next % POOL_SIZE;
            if lane == STATEFUL_LANE {
                *next = next.wrapping_add(1);
                lane = *next % POOL_SIZE;
            }
            *next = next.wrapping_add(1);
            lane
        };
        if let Some(conn) = self
            .connections
            .lock()
            .unwrap()
            .get(host_id)
            .and_then(|pool| pool.get(lane).cloned())
        {
            return Ok(conn);
        }
        self.insert_lane(host_id, lane, remote_bin, remote_root)
    }

    /// Fetch-or-spawn a fixed lane without touching the round-robin cursor.
    /// Used by stateful methods so a spawn/poll/kill sequence always lands
    /// on the same agent process (and by nobody else).
    fn pinned_connection(
        &self,
        host_id: &str,
        remote_bin: &str,
        remote_root: &str,
        lane: usize,
    ) -> Result<Arc<RpcConnection>, String> {
        if let Some(conn) = self
            .connections
            .lock()
            .unwrap()
            .get(host_id)
            .and_then(|pool| pool.get(lane).cloned())
        {
            return Ok(conn);
        }
        self.insert_lane(host_id, lane, remote_bin, remote_root)
    }

    fn insert_lane(
        &self,
        host_id: &str,
        lane: usize,
        remote_bin: &str,
        remote_root: &str,
    ) -> Result<Arc<RpcConnection>, String> {
        let host = host_store()
            .get(host_id)
            .ok_or_else(|| format!("unknown SSH host: {host_id}"))?;
        let conn = self.spawn_lane(&host, remote_bin, remote_root)?;
        let mut pools = self.connections.lock().unwrap();
        let pool = pools.entry(host_id.to_string()).or_default();
        if lane < pool.len() {
            // Another thread won the race and filled this lane first; use
            // theirs and drop ours (our child process gets killed here).
            let existing = pool[lane].clone();
            drop(pools);
            if let Ok(mut rpc) = conn.rpc.lock() {
                let _ = rpc.child.kill();
            }
            return Ok(existing);
        }
        // Lanes are positional by round-robin index; pad any gap so that
        // pool[lane] is always this lane's connection.
        while pool.len() < lane {
            pool.push(conn.clone());
        }
        pool.push(conn.clone());
        Ok(conn)
    }

    /// Stateful call: carries the v3 lane affinity through to the agent so
    /// the request resolves in the pinned handle namespace. Stateless
    /// callers use `call` (no lane = legacy shared namespace).
    fn call_with_lane(
        &self,
        conn: &Arc<RpcConnection>,
        host_id: &str,
        method: &str,
        params: Value,
        lane: Option<u8>,
    ) -> Result<Value, String> {
        let response = self.call_raw_with_lane(conn, method, params, lane)?;
        return self.finish_call(conn, host_id, response);
    }

    fn call(
        &self,
        conn: &Arc<RpcConnection>,
        host_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let response = self.call_raw(conn, method, params)?;
        return self.finish_call(conn, host_id, response);
    }

    fn finish_call(
        &self,
        _conn: &Arc<RpcConnection>,
        host_id: &str,
        response: Value,
    ) -> Result<Value, String> {
        // Version learning happens only at spawn (ping handshake): pooled
        // lanes are shared through cloned Arcs, so per-response upgrades
        // would need interior mutability for zero benefit.
        if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
        let err = response
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("remote request failed");
        // A dead channel poisons future calls; drop it so the next request
        // re-establishes.
        if err.contains("io") || err.contains("channel") {
            self.drop_connection(host_id);
        }
        Err(err.to_string())
    }

    fn call_raw(
        &self,
        conn: &Arc<RpcConnection>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.call_raw_with_lane(conn, method, params, None)
    }

    /// Raw call carrying an optional v3 lane affinity. The lane is only
    /// sent when the far end advertised protocol >= 3; older agents get
    /// the v2 envelope and resolve to the legacy shared namespace.
    fn call_raw_with_lane(
        &self,
        conn: &Arc<RpcConnection>,
        method: &str,
        params: Value,
        lane: Option<u8>,
    ) -> Result<Value, String> {
        let id = request_id();
        let token = conn.token.clone();
        let mut envelope = serde_json::json!({
            "protocol": terax_control_protocol::REMOTE_PROTOCOL_VERSION,
            "id": id,
            "token": token,
            "method": method,
            "params": params,
        });
        if conn.protocol >= 3 {
            if let Some(l) = lane {
                envelope["lane"] = serde_json::json!(l);
            }
        }
        let line = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
        // Hold the lock for the whole round-trip: stdio is a single stream
        // and interleaved requests would corrupt framing.
        let mut rpc = conn.rpc.lock().map_err(|_| "rpc lock poisoned".to_string())?;
        rpc.stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("rpc write: {e}"))?;
        rpc.stdin.write_all(b"\n").map_err(|e| format!("rpc write: {e}"))?;
        rpc.stdin.flush().map_err(|e| format!("rpc flush: {e}"))?;
        let reader = &mut rpc.reader;
        let mut line_buf: Vec<u8> = Vec::new();
        let deadline = std::time::Instant::now() + RPC_TIMEOUT;
        loop {
            if std::time::Instant::now() >= deadline {
                return Err("remote request timed out".into());
            }
            let mut byte = [0u8; 1];
            match read_byte_with_timeout(reader, &mut byte, deadline) {
                Ok(0) => return Err("remote agent closed the channel".into()),
                Ok(_) => {
                    line_buf.push(byte[0]);
                    if byte[0] == b'\n' {
                        break;
                    }
                    if line_buf.len() > MAX_MESSAGE_BYTES {
                        return Err("remote response too large".into());
                    }
                }
                Err(e) => return Err(e),
            }
        }
        let response: Value =
            serde_json::from_slice(&line_buf).map_err(|e| format!("invalid remote response: {e}"))?;
        Ok(response)
    }
}

fn read_byte_with_timeout(
    reader: &mut BufReader<ChildStdout>,
    byte: &mut [u8; 1],
    deadline: std::time::Instant,
) -> Result<usize, String> {
    loop {
        // BufReader over a pipe blocks; poll in short slices so the deadline
        // stays responsive without losing buffered bytes.
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("remote request timed out".into());
        }
        // Try a non-blocking fill: if the pipe has data, read it.
        match reader.fill_buf() {
            Ok(buf) if !buf.is_empty() => {
                byte[0] = buf[0];
                reader.consume(1);
                return Ok(1);
            }
            Ok(_) => {}
            Err(e) => return Err(format!("rpc read: {e}")),
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stateful_methods_are_pinned() {
        for (m, lane) in [
            ("shell_session_open", AFFINITY_SHELL_SESSION),
            ("shell_session_run", AFFINITY_SHELL_SESSION),
            ("shell_session_close", AFFINITY_SHELL_SESSION),
            ("shell_bg_spawn", AFFINITY_SHELL_BG),
            ("shell_bg_logs", AFFINITY_SHELL_BG),
            ("shell_bg_kill", AFFINITY_SHELL_BG),
            ("docker_pull", AFFINITY_DOCKER_PULL),
            ("docker_logs_spawn", AFFINITY_DOCKER_LOGS),
            ("docker_logs_poll", AFFINITY_DOCKER_LOGS),
            ("docker_logs_kill", AFFINITY_DOCKER_LOGS),
            ("docker_events_spawn", AFFINITY_DOCKER_EVENTS),
            ("docker_events_poll", AFFINITY_DOCKER_EVENTS),
            ("docker_events_kill", AFFINITY_DOCKER_EVENTS),
            ("docker_compose_logs", AFFINITY_COMPOSE_LOGS),
        ] {
            assert!(is_stateful_method(m), "{m} must pin to the stateful lane");
            assert_eq!(affinity_for(m), Some(lane), "{m} must carry lane {lane}");
        }
    }

    #[test]
    fn spawn_poll_kill_share_one_affinity() {
        // The invariant that actually prevents no_handle: every verb of a
        // sequence resolves to the same namespace.
        assert_eq!(affinity_for("docker_logs_spawn"), affinity_for("docker_logs_poll"));
        assert_eq!(affinity_for("docker_logs_poll"), affinity_for("docker_logs_kill"));
        assert_eq!(affinity_for("docker_events_spawn"), affinity_for("docker_events_poll"));
        assert_eq!(affinity_for("docker_events_poll"), affinity_for("docker_events_kill"));
    }

    #[test]
    fn stateless_methods_stay_on_pool() {
        for m in [
            "ping",
            "fs_read_dir",
            "docker_ps",
            "docker_inspect",
            "docker_images",
            "docker_compose_ps",
            "shell_exec",
        ] {
            assert!(!is_stateful_method(m), "{m} must not pin to the stateful lane");
            assert_eq!(affinity_for(m), None, "{m} must not carry affinity");
        }
    }

    #[test]
    fn request_ids_are_unique() {
        assert_ne!(request_ids_are_unique_check(), request_ids_are_unique_check());
    }

    fn request_ids_are_unique_check() -> String {
        request_id()
    }

    #[test]
    fn generated_tokens_are_64_hex() {
        let t = generate_token().unwrap();
        assert_eq!(t.len(), 64);
        assert!(t.bytes().all(|b| b.is_ascii_hexdigit()));
    }
}
