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
}

pub struct SshRpcManager {
    connections: Mutex<HashMap<String, Arc<RpcConnection>>>,
}

impl Default for SshRpcManager {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
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

impl SshRpcManager {
    /// Sends a request to the host agent, spawning the channel on first use.
    /// The agent binary path on the remote is resolved at connect time.
    pub fn request(
        &self,
        host_id: &str,
        method: &str,
        params: Value,
        remote_bin: &str,
        remote_root: &str,
    ) -> Result<Value, String> {
        validate_host_id(host_id).map_err(|m| m)?;
        let conn = self.connection(host_id, remote_bin, remote_root)?;
        self.call(&conn, host_id, method, params)
    }

    pub fn drop_connection(&self, host_id: &str) {
        if let Some(conn) = self.connections.lock().unwrap().remove(host_id) {
            if let Ok(mut rpc) = conn.rpc.lock() {
                let _ = rpc.child.kill();
            }
        }
    }

    fn connection(
        &self,
        host_id: &str,
        remote_bin: &str,
        remote_root: &str,
    ) -> Result<Arc<RpcConnection>, String> {
        if let Some(conn) = self.connections.lock().unwrap().get(host_id).cloned() {
            return Ok(conn);
        }
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
        let conn = Arc::new(RpcConnection {
            rpc: Mutex::new(RpcChild {
                child,
                stdin,
                reader: BufReader::new(stdout),
            }),
            token,
        });
        // Verify the channel before caching: ping must succeed.
        let ping = self.call_raw(&conn, "ping", serde_json::json!({}))?;
        if !ping.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return Err("remote agent ping failed".into());
        }
        self.connections
            .lock()
            .unwrap()
            .insert(host_id.to_string(), conn.clone());
        Ok(conn)
    }

    fn call(
        &self,
        conn: &Arc<RpcConnection>,
        host_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let response = self.call_raw(conn, method, params)?;
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
        let id = request_id();
        let token = conn.token.clone();
        let line = serde_json::to_string(&serde_json::json!({
            "protocol": terax_control_protocol::REMOTE_PROTOCOL_VERSION,
            "id": id,
            "token": token,
            "method": method,
            "params": params,
        }))
        .map_err(|e| e.to_string())?;
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
    use std::io::Read;
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
