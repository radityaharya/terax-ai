use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::mpsc;
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

/// One stdio pipe to a host's agent, plus the dispatch table that routes
/// responses back to their caller by request id. The agent serves requests
/// concurrently and may answer out of order, so the desktop must match
/// responses to waiters instead of assuming the next line is its own. This
/// replaces the old POOL_SIZE lane pipes: a single multiplexed pipe now
/// provides concurrency without opening (on Windows) a full extra SSH
/// handshake per lane.
struct RpcConnection {
    child: Mutex<Child>,
    writer: Mutex<ChildStdin>,
    pending: Arc<Pending>,
    alive: Arc<AtomicBool>,
    token: String,
    /// Agent protocol, learned from the spawn ping. Gates additive envelope
    /// fields (lane) so an older agent is never sent a field it cannot read.
    protocol: AtomicU16,
}

/// Responses awaiting a caller, keyed by request id. A caller registers a
/// channel before writing and waits on it; a reader thread completes it when
/// the matching response line arrives.
#[derive(Default)]
struct Pending {
    waiters: Mutex<HashMap<String, mpsc::Sender<Value>>>,
}

impl Pending {
    fn register(&self, id: &str) -> mpsc::Receiver<Value> {
        let (tx, rx) = mpsc::channel();
        self.waiters.lock().unwrap().insert(id.to_string(), tx);
        rx
    }

    /// Route a response to its waiter. Returns false when no caller is
    /// waiting (a timed-out request, or a duplicate/unsolicited line).
    fn complete(&self, id: &str, value: Value) -> bool {
        match self.waiters.lock().unwrap().remove(id) {
            Some(tx) => tx.send(value).is_ok(),
            None => false,
        }
    }

    fn cancel(&self, id: &str) {
        self.waiters.lock().unwrap().remove(id);
    }

    /// Drop every waiter, disconnecting their channels. Called when the pipe
    /// ends so callers fail immediately instead of waiting out RPC_TIMEOUT.
    fn fail_all(&self) {
        self.waiters.lock().unwrap().clear();
    }
}

/// Reads newline-delimited responses and dispatches each to its waiter.
/// Nothing here assumes request order: the agent is concurrent, so `id` is
/// the only correlation key.
fn spawn_reader(stdout: ChildStdout, pending: Arc<Pending>, alive: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    if buf.len() > MAX_MESSAGE_BYTES {
                        // Oversized frame: the framing contract is broken,
                        // stop reading rather than desync on a partial line.
                        break;
                    }
                    if let Ok(value) = serde_json::from_slice::<Value>(&buf) {
                        let id = value
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if let Some(id) = id {
                            pending.complete(&id, value);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        alive.store(false, Ordering::SeqCst);
        pending.fail_all();
    });
}

pub struct SshRpcManager {
    /// host_id -> the single multiplexed pipe.
    connections: Mutex<HashMap<String, Arc<RpcConnection>>>,
    /// Serializes pipe creation so a first-use burst opens one channel, not
    /// one per racing caller.
    spawn_lock: Mutex<()>,
}

impl Default for SshRpcManager {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            spawn_lock: Mutex::new(()),
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

/// v3+ affinity lanes for stateful namespaces. One u8 tag per follow class:
/// the desktop pins each spawn/poll/kill sequence to its tag, and the agent
/// resolves the tag to an isolated handle map. Tags are stable wire values
/// (do not renumber): a future transport relocates namespaces by tag.
pub const AFFINITY_DEFAULT: u8 = 0;
pub const AFFINITY_SHELL_BG: u8 = 1;
pub const AFFINITY_SHELL_SESSION: u8 = 2;
pub const AFFINITY_DOCKER_LOGS: u8 = 3;
pub const AFFINITY_DOCKER_EVENTS: u8 = 4;
pub const AFFINITY_DOCKER_PULL: u8 = 5;
pub const AFFINITY_COMPOSE_LOGS: u8 = 6;

/// Stateful method -> its v3 affinity tag. None = stateless (any order; the
/// request carries full params).
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
    /// Stateful methods carry their v3 affinity tag so the agent resolves
    /// spawn/poll/kill in the same isolated handle namespace even though all
    /// traffic now shares one pipe.
    pub fn request(
        &self,
        host_id: &str,
        method: &str,
        params: Value,
        remote_bin: &str,
        remote_root: &str,
    ) -> Result<Value, String> {
        validate_host_id(host_id)?;
        let conn = self.connection(host_id, remote_bin, remote_root)?;
        let response = self.call_raw_with_lane(&conn, method, params, affinity_for(method))?;
        self.finish_call(&conn, host_id, response)
    }

    pub fn drop_connection(&self, host_id: &str) {
        if let Some(conn) = self.connections.lock().unwrap().remove(host_id) {
            conn.alive.store(false, Ordering::SeqCst);
            conn.pending.fail_all();
            if let Ok(mut child) = conn.child.lock() {
                let _ = child.kill();
            }
        }
    }

    /// Fetch-or-spawn the host's pipe. A dead pipe (reader thread exited) is
    /// discarded and replaced; live ones are shared, since responses are
    /// dispatched by id and the agent serves requests concurrently.
    fn connection(
        &self,
        host_id: &str,
        remote_bin: &str,
        remote_root: &str,
    ) -> Result<Arc<RpcConnection>, String> {
        if let Some(conn) = self.live_connection(host_id) {
            return Ok(conn);
        }
        let _guard = self.spawn_lock.lock().unwrap();
        if let Some(conn) = self.live_connection(host_id) {
            return Ok(conn);
        }
        let conn = self.spawn_connection(host_id, remote_bin, remote_root)?;
        self.connections
            .lock()
            .unwrap()
            .insert(host_id.to_string(), conn.clone());
        Ok(conn)
    }

    fn live_connection(&self, host_id: &str) -> Option<Arc<RpcConnection>> {
        let mut pools = self.connections.lock().unwrap();
        match pools.get(host_id).cloned() {
            Some(conn) if conn.alive.load(Ordering::SeqCst) => Some(conn),
            Some(_) => {
                pools.remove(host_id);
                None
            }
            None => None,
        }
    }

    fn spawn_connection(
        &self,
        host_id: &str,
        remote_bin: &str,
        remote_root: &str,
    ) -> Result<Arc<RpcConnection>, String> {
        let host = host_store()
            .get(host_id)
            .ok_or_else(|| format!("unknown SSH host: {host_id}"))?;
        let token = generate_token().map_err(|e| e.to_string())?;
        let remote_cmd = format!("{remote_bin} serve --root {remote_root} --token {token}");
        let args = rpc_args(&host, &remote_cmd);
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
        let pending = Arc::new(Pending::default());
        let alive = Arc::new(AtomicBool::new(true));
        // The reader must be running before the ping so its response can be
        // dispatched to the waiter registered below.
        spawn_reader(stdout, pending.clone(), alive.clone());
        let conn = Arc::new(RpcConnection {
            child: Mutex::new(child),
            writer: Mutex::new(stdin),
            pending,
            alive,
            token,
            // Pessimistic until the ping proves otherwise.
            protocol: AtomicU16::new(2),
        });
        let ping = self.call_raw(&conn, "ping", serde_json::json!({}))?;
        if !ping.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            conn.alive.store(false, Ordering::SeqCst);
            if let Ok(mut c) = conn.child.lock() {
                let _ = c.kill();
            }
            return Err("remote agent ping failed".into());
        }
        let advertised = ping
            .get("result")
            .and_then(|r| r.get("protocol"))
            .and_then(Value::as_u64)
            .unwrap_or(2) as u16;
        conn.protocol.store(advertised.max(2), Ordering::SeqCst);
        Ok(conn)
    }

    fn finish_call(
        &self,
        _conn: &Arc<RpcConnection>,
        host_id: &str,
        response: Value,
    ) -> Result<Value, String> {
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

    /// One multiplexed round trip: register a waiter for the id, write the
    /// request under the writer lock (held only for the write), then wait for
    /// the reader thread to dispatch the matching response. The lock is never
    /// held across the round trip, so concurrent calls flow through one pipe.
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
        if conn.protocol.load(Ordering::SeqCst) >= 3 {
            if let Some(l) = lane {
                envelope["lane"] = serde_json::json!(l);
            }
        }
        let mut line = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let rx = conn.pending.register(&id);
        {
            let mut writer = conn.writer.lock().map_err(|_| "rpc lock poisoned".to_string())?;
            if let Err(e) = writer.write_all(&line).and_then(|_| writer.flush()) {
                drop(writer);
                conn.pending.cancel(&id);
                return Err(format!("rpc write: {e}"));
            }
        }
        match rx.recv_timeout(RPC_TIMEOUT) {
            Ok(value) => Ok(value),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                conn.pending.cancel(&id);
                Err("remote request timed out".into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("remote agent closed the channel".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn stateless_methods_carry_no_affinity() {
        for m in [
            "ping",
            "fs_read_dir",
            "docker_ps",
            "docker_inspect",
            "docker_images",
            "docker_compose_ps",
            "shell_exec",
        ] {
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

    #[test]
    fn pending_routes_responses_by_id_out_of_order() {
        // The agent answers concurrently; a response for "b" arriving before
        // "a" must still reach the caller that is waiting on "b".
        let pending = Pending::default();
        let rx_a = pending.register("a");
        let rx_b = pending.register("b");
        assert!(pending.complete("b", json!({ "id": "b", "ok": true })));
        assert!(pending.complete("a", json!({ "id": "a", "ok": true })));
        assert_eq!(rx_b.recv().unwrap()["id"], "b");
        assert_eq!(rx_a.recv().unwrap()["id"], "a");
    }

    #[test]
    fn pending_ignores_unknown_and_duplicate_ids() {
        let pending = Pending::default();
        assert!(!pending.complete("nobody", json!({ "id": "nobody" })));
        let _rx = pending.register("a");
        assert!(pending.complete("a", json!({ "id": "a" })));
        // Second completion for the same id has no waiter left.
        assert!(!pending.complete("a", json!({ "id": "a" })));
    }

    #[test]
    fn pending_cancel_drops_a_timed_out_waiter() {
        let pending = Pending::default();
        let _rx = pending.register("a");
        pending.cancel("a");
        assert!(!pending.complete("a", json!({ "id": "a" })));
    }

    #[test]
    fn pending_fail_all_disconnects_waiters() {
        let pending = Pending::default();
        let rx = pending.register("a");
        pending.fail_all();
        assert!(matches!(rx.recv(), Err(mpsc::RecvError)));
    }
}
