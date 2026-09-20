use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use terax_control_protocol::ControlResponse;
use terax_core::docker::{
    build_prune_argv, compose_prefix, parse_pull_progress_line, parse_replicas, parse_stats_json,
    parse_system_df, probe_capabilities, prune_target, registry_has_update, validate_container_id,
    with_files, COMPOSE_FILENAMES,
};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Per-agent Docker state: log/event background handles plus short-lived
/// caches. Handles are namespaced by v3 lane (process-local today, same as
/// the shell bg maps in main.rs): lane 0 / absent is the legacy shared
/// namespace; nonzero lanes isolate follows so a relocated transport can
/// move namespaces without wire changes.
pub struct DockerLane {
    pub logs: Mutex<HashMap<u32, Arc<terax_core::shell::background::BackgroundProc>>>,
    pub events: Mutex<HashMap<u32, Arc<terax_core::shell::background::BackgroundProc>>>,
    pub next_handle: AtomicU32,
}

impl Default for DockerLane {
    fn default() -> Self {
        Self {
            logs: Mutex::new(HashMap::new()),
            events: Mutex::new(HashMap::new()),
            next_handle: AtomicU32::new(1),
        }
    }
}

pub struct DockerShared {
    pub lanes: Mutex<HashMap<u8, DockerLane>>,
    pub capabilities: Mutex<HashMap<String, (u64, Value)>>,
}

impl Default for DockerShared {
    fn default() -> Self {
        Self {
            lanes: Mutex::new(HashMap::new()),
            capabilities: Mutex::new(HashMap::new()),
        }
    }
}

/// Desktop affinity tags (must match rpc.rs AFFINITY_*). Documented here
/// for debuggability — the agent treats lane ids as opaque namespaces.
/// Pull procs live in the events map regardless of tag; the tag only
/// isolates namespaces.
#[allow(dead_code)]
pub const AFFINITY_DOCKER_LOGS: u8 = 3;
#[allow(dead_code)]
pub const AFFINITY_DOCKER_EVENTS: u8 = 4;
#[allow(dead_code)]
pub const AFFINITY_DOCKER_PULL: u8 = 5;
#[allow(dead_code)]
pub const AFFINITY_COMPOSE_LOGS: u8 = 6;

impl DockerShared {
    /// Resolve (logs map, events map, handle counter) for a v3 lane.
    /// Lane 0 / absent = legacy shared namespace (pre-v3 clients).
    ///
    /// Tag mapping: LOGS + COMPOSE_LOGS -> logs map of their own lane;
    /// EVENTS + PULL -> events map of their own lane (pull procs live in
    /// events — poll/kill with the pull tag must hit the same map the
    /// spawn used, which is exactly what this mapping guarantees).
    /// Snapshot one proc out of a lane namespace. Holds the outer lanes
    /// lock only for map lookup; the proc itself is refcounted so the
    /// ring-buffer read below runs lock-free.
    pub fn lane_get(
        &self,
        lane: Option<u8>,
        is_logs: bool,
        handle: u32,
    ) -> Option<Arc<terax_core::shell::background::BackgroundProc>> {
        let lanes = self.lanes.lock().unwrap();
        lanes
            .get(&lane.unwrap_or(0))
            .and_then(|state| {
                let map = if is_logs { &state.logs } else { &state.events };
                map.lock().unwrap().get(&handle).cloned()
            })
    }

    /// Insert one proc into a lane namespace, materializing the lane on
    /// first use. Returns the lane-local handle.
    pub fn lane_insert(
        &self,
        lane: Option<u8>,
        is_logs: bool,
        proc: Arc<terax_core::shell::background::BackgroundProc>,
    ) -> u32 {
        let mut lanes = self.lanes.lock().unwrap();
        let state = lanes.entry(lane.unwrap_or(0)).or_default();
        let handle = state.next_handle.fetch_add(1, Ordering::Relaxed);
        let map = if is_logs { &state.logs } else { &state.events };
        map.lock().unwrap().insert(handle, proc);
        handle
    }
}

const CAPABILITIES_TTL_MS: u64 = 60_000;

fn failure(id: String, code: &str, message: String) -> ControlResponse {
    ControlResponse::failure(id, code, message)
}

fn ok(id: String, result: Value) -> ControlResponse {
    ControlResponse::success(id, result)
}

/// Run a server-built docker argv synchronously (60s cap). The argv is
/// assembled by this module only — callers never pass freeform commands.
/// Spawns argv[0] directly (no shell), so validated identifiers cannot
/// smuggle metacharacters even if a validator regresses.
fn run_docker(args: &[String], cwd: Option<&str>) -> Result<terax_core::shell::CommandOutput, String> {
    use std::io::Read;
    use std::time::Duration;
    if args.is_empty() || args[0] != "docker" && args[0] != "docker-compose" {
        return Err("docker argv must start with docker".into());
    }
    let timeout = Duration::from_secs(60);
    let mut cmd = std::process::Command::new(&args[0]);
    for a in &args[1..] {
        cmd.arg(a);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = Arc::new(shared_child::SharedChild::spawn(&mut cmd).map_err(|e| format!("spawn docker: {e}"))?);
    let mut stdout_pipe = child.take_stdout();
    let mut stderr_pipe = child.take_stderr();
    let out_h = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(ref mut p) = stdout_pipe {
            let _ = p.read_to_end(&mut b);
        }
        b
    });
    let err_h = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(ref mut p) = stderr_pipe {
            let _ = p.read_to_end(&mut b);
        }
        b
    });
    let (tx, rx) = std::sync::mpsc::channel();
    let waiter = Arc::clone(&child);
    std::thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });
    let (exit_code, timed_out) = match rx.recv_timeout(timeout) {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(e.to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(_) => return Err("docker wait disconnected".into()),
    };
    let stdout = out_h.join().unwrap_or_default();
    let stderr = err_h.join().unwrap_or_default();
    Ok(terax_core::shell::CommandOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
        timed_out,
        truncated: false,
    })
}

fn str_param(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn opt_str(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

fn bool_param(params: &Value, key: &str) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn str_list(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Swam `stack ps --format json` emits one object per task with
/// `CurrentState` ("Running", "Shutdown", "Failed", "Rejected", "Pending",
/// "Preparing", "Complete", ...). A task counts as healthy for the stack
/// rollup when the daemon is actively hosting it.
fn task_healthy(task: &Value) -> bool {
    task.get("CurrentState")
        .and_then(Value::as_str)
        .map(|s| {
            let s = s.to_ascii_lowercase();
            s.starts_with("running") || s.starts_with("complete")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod task_health_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn running_and_complete_count_as_healthy() {
        assert!(task_healthy(&json!({ "CurrentState": "Running" })));
        assert!(task_healthy(&json!({ "CurrentState": "Running 3 minutes ago" })));
        assert!(task_healthy(&json!({ "CurrentState": "Complete" })));
    }

    #[test]
    fn failed_shutdown_rejected_pending_are_not_healthy() {
        for state in ["Failed", "Shutdown", "Rejected", "Pending", "Preparing", "New", ""] {
            assert!(
                !task_healthy(&json!({ "CurrentState": state })),
                "{state} must not count as healthy"
            );
        }
        assert!(!task_healthy(&json!({})));
    }
}

/// Dispatch one docker_* route. `authorized` gates path-scoped ops,
/// `is_authorized_path` is the agent's root check passed in from main.
pub fn handle_docker(
    state: &DockerShared,
    method: &str,
    id: String,
    params: &Value,
    authorized: impl Fn(&PathBuf) -> bool,
    lane: Option<u8>,
) -> Option<ControlResponse> {
    if !method.starts_with("docker_") {
        return None;
    }
    let denied = |id: String| failure(id, "path_not_accessible", "path is outside the authorized workspace".into());
    let docker_err = |id: String, out: &terax_core::shell::CommandOutput| {
        if out.timed_out {
            return failure(id, "docker_timeout", "docker command timed out".into());
        }
        let msg = out.stderr.trim();
        if msg.to_ascii_lowercase().contains("permission denied")
            || msg.to_ascii_lowercase().contains("permissiondenied")
            || msg.contains("Got permission denied")
        {
            return failure(id, "docker_permission", msg.to_string());
        }
        if msg.to_ascii_lowercase().contains("cannot connect to the docker daemon")
            || msg.to_ascii_lowercase().contains("is the docker daemon running")
            || msg.to_ascii_lowercase().contains("connection refused")
            || msg.to_ascii_lowercase().contains("no such file or directory")
                && msg.contains("docker.sock")
        {
            return failure(id, "docker_daemon_down", msg.to_string());
        }
        failure(id, "docker_error", if msg.is_empty() { format!("docker exited {}", out.exit_code.unwrap_or(-1)) } else { msg.to_string() })
    };
    let run = |argv: Vec<String>, cwd: Option<&str>| run_docker(&argv, cwd);

    Some(match method {
        "docker_capabilities" => {
            let cache_key = "default".to_string();
            if let Some((at, cached)) = state.capabilities.lock().unwrap().get(&cache_key).cloned() {
                if now_ms().saturating_sub(at) < CAPABILITIES_TTL_MS {
                    return Some(ok(id, cached));
                }
            }
            let version = run(vec!["docker".into(), "version".into(), "--format".into(), "json".into()], None);
            let version_json = match version {
                Ok(o) if o.exit_code == Some(0) => o.stdout,
                Ok(o) => return Some(docker_err(id, &o)),
                Err(e) => {
                    // docker binary missing entirely.
                    let caps = terax_core::docker::DockerCapabilities {
                        installed: false,
                        ..Default::default()
                    };
                    let v = json!(caps);
                    state.capabilities.lock().unwrap().insert(cache_key, (now_ms(), v.clone()));
                    let _ = e;
                    return Some(ok(id, v));
                }
            };
            let compose_v2 = run(vec!["docker".into(), "compose".into(), "version".into()], None)
                .map(|o| o.exit_code == Some(0))
                .unwrap_or(false);
            let compose_v1 = run(vec!["docker-compose".into(), "version".into()], None)
                .map(|o| o.exit_code == Some(0))
                .unwrap_or(false);
            let swarm_state = run(
                vec!["docker".into(), "info".into(), "--format".into(), "{{.Swarm.LocalNodeState}}".into()],
                None,
            )
            .map(|o| o.stdout.trim().to_string())
            .unwrap_or_default();
            let rootless = run(vec!["docker".into(), "info".into(), "--format".into(), "{{.SecurityOptions}}".into()], None)
                .map(|o| o.stdout.contains("rootless"))
                .unwrap_or(false);
            let context = run(vec!["docker".into(), "context".into(), "show".into()], None)
                .map(|o| o.stdout.trim().to_string())
                .unwrap_or_default();
            let permission_denied = version_json.is_empty();
            let caps = probe_capabilities(&version_json, compose_v2, compose_v1, &swarm_state, rootless, &context, permission_denied);
            let v = json!(caps);
            state.capabilities.lock().unwrap().insert(cache_key, (now_ms(), v.clone()));
            ok(id, v)
        }
        "docker_ps" => {
            let all = bool_param(params, "all");
            let mut argv = vec!["docker".into(), "ps".into(), "--format".into(), "json".into()];
            if all {
                argv.push("-a".into());
            }
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_inspect" => {
            let kind = str_param(params, "kind");
            let target = str_param(params, "id");
            if let Err(e) = validate_container_id(&target) {
                return Some(failure(id, "invalid_id", e));
            }
            let object = match kind.as_str() {
                "container" => "container",
                "image" => "image",
                "volume" => "volume",
                "network" => "network",
                "service" => "service",
                _ => return Some(failure(id, "invalid_kind", format!("unknown inspect kind: {kind}"))),
            };
            let argv = vec!["docker".into(), object.into(), "inspect".into(), target];
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => {
                    let v: Value = serde_json::from_str(o.stdout.trim()).unwrap_or(Value::Null);
                    ok(id, v)
                }
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_start" | "docker_stop" | "docker_restart" | "docker_kill" | "docker_rm" => {
            let ids = str_list(params, "ids");
            if ids.is_empty() {
                return Some(failure(id, "invalid_id", "no container ids".into()));
            }
            for c in &ids {
                if let Err(e) = validate_container_id(c) {
                    return Some(failure(id, "invalid_id", e));
                }
            }
            let verb = method["docker_".len()..].to_string();
            let mut argv = vec!["docker".into(), verb];
            if method == "docker_rm" && bool_param(params, "force") {
                argv.push("-f".into());
            }
            if (method == "docker_stop" || method == "docker_restart") && params.get("timeout").and_then(Value::as_u64).is_some() {
                argv.push("-t".into());
                argv.push(params.get("timeout").and_then(Value::as_u64).unwrap_or(10).to_string());
            }
            argv.extend(ids);
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_rmi" => {
            let ids = str_list(params, "ids");
            if ids.is_empty() {
                return Some(failure(id, "invalid_id", "no image ids".into()));
            }
            for c in &ids {
                if let Err(e) = validate_container_id(c) {
                    return Some(failure(id, "invalid_id", e));
                }
            }
            let mut argv = vec!["docker".into(), "rmi".into()];
            if bool_param(params, "force") {
                argv.push("-f".into());
            }
            argv.extend(ids);
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_volume_rm" => {
            let names = str_list(params, "names");
            if names.is_empty() {
                return Some(failure(id, "invalid_id", "no volume names".into()));
            }
            for c in &names {
                if let Err(e) = validate_container_id(c) {
                    return Some(failure(id, "invalid_id", e));
                }
            }
            let mut argv = vec!["docker".into(), "volume".into(), "rm".into()];
            argv.extend(names);
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_network_rm" => {
            let names = str_list(params, "names");
            if names.is_empty() {
                return Some(failure(id, "invalid_id", "no network names".into()));
            }
            for c in &names {
                if let Err(e) = validate_container_id(c) {
                    return Some(failure(id, "invalid_id", e));
                }
            }
            let mut argv = vec!["docker".into(), "network".into(), "rm".into()];
            argv.extend(names);
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_prune" => {
            let target = match prune_target(&str_param(params, "target")) {
                Ok(t) => t,
                Err(e) => return Some(failure(id, "invalid_target", e)),
            };
            let argv = build_prune_argv(target, bool_param(params, "all"), bool_param(params, "volumes"));
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_container_shell_probe" => {
            let target = str_param(params, "id");
            if let Err(e) = validate_container_id(&target) {
                return Some(failure(id, "invalid_id", e));
            }
            // Probe cheapest-first: sh is near-universal.
            let mut found: Option<String> = None;
            for shell in ["sh", "bash", "ash"] {
                let argv = vec![
                    "docker".into(),
                    "exec".into(),
                    target.clone(),
                    "command".into(),
                    "-v".into(),
                    shell.into(),
                ];
                if let Ok(o) = run(argv, None) {
                    if o.exit_code == Some(0) {
                        found = Some(shell.to_string());
                        break;
                    }
                }
            }
            ok(id, json!({ "shell": found }))
        }
        "docker_system_df" => {
            match run(vec!["docker".into(), "system".into(), "df".into(), "--format".into(), "json".into()], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(parse_system_df(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_stats" => {
            let ids = str_list(params, "ids");
            let mut argv = vec!["docker".into(), "stats".into(), "--no-stream".into(), "--format".into(), "json".into()];
            argv.extend(ids);
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(parse_stats_json(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_images" => {
            match run(vec!["docker".into(), "images".into(), "--format".into(), "json".into()], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_volumes_ls" => {
            match run(vec!["docker".into(), "volume".into(), "ls".into(), "--format".into(), "json".into()], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_networks_ls" => {
            match run(vec!["docker".into(), "network".into(), "ls".into(), "--format".into(), "json".into()], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_image_history" => {
            let target = str_param(params, "id");
            if let Err(e) = validate_container_id(&target) {
                return Some(failure(id, "invalid_id", e));
            }
            match run(vec!["docker".into(), "history".into(), "--format".into(), "json".into(), "--no-trunc".into(), target], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_image_diff" => {
            let _ = validate_container_id(&str_param(params, "id")).map_err(|e| e);
            return Some(failure(id, "not_implemented", "image diff arrives in M2".into()));
        }
        "docker_image_tag" => {
            let source = str_param(params, "source");
            let target = str_param(params, "target");
            if let Err(e) = validate_container_id(&source).and(validate_container_id(&target)) {
                return Some(failure(id, "invalid_id", e));
            }
            match run(vec!["docker".into(), "tag".into(), source, target], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_image_push" => {
            let target = str_param(params, "target");
            if let Err(e) = validate_container_id(&target) {
                return Some(failure(id, "invalid_id", e));
            }
            match run(vec!["docker".into(), "push".into(), target], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_registry_list" => {
            // No daemon support for registry listing; the frontend keeps its
            // own list of logged-in registries per host.
            ok(id, json!([]))
        }
        "docker_registry_login" | "docker_registry_logout" => {
            let registry = str_param(params, "registry");
            if registry.is_empty() || registry.len() > 253 || registry.contains([' ', '\t', '\n', '\r']) {
                return Some(failure(id, "invalid_registry", "bad registry".into()));
            }
            if method == "docker_registry_logout" {
                match run(vec!["docker".into(), "logout".into(), registry], None) {
                    Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                    Ok(o) => docker_err(id, &o),
                    Err(e) => failure(id, "docker_error", e),
                }
            } else {
                // Credentials arrive via keyring-scoped frontend flow in D3.5;
                // the agent accepts username+password params only over the
                // token-authenticated channel, never logs them.
                let username = str_param(params, "username");
                let password = str_param(params, "password");
                if username.is_empty() || password.is_empty() {
                    return Some(failure(id, "invalid_auth", "username and password required".into()));
                }
                let mut cmd = std::process::Command::new("docker");
                cmd.arg("login")
                    .arg("--username")
                    .arg(&username)
                    .arg("--password-stdin")
                    .arg(&registry)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped());
                let mut child = match cmd.spawn() {
                    Ok(c) => c,
                    Err(e) => return Some(failure(id, "docker_error", e.to_string())),
                };
                use std::io::Write;
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(password.as_bytes());
                }
                match child.wait_with_output() {
                    Ok(o) if o.status.success() => ok(id, json!(null)),
                    Ok(o) => failure(id, "docker_error", String::from_utf8_lossy(&o.stderr).trim().to_string()),
                    Err(e) => failure(id, "docker_error", e.to_string()),
                }
            }
        }
        "docker_pull" => {
            return Some(docker_bg_spawn(state, id, params, "pull", lane));
        }
        "docker_build" => {
            return Some(docker_bg_spawn(state, id, params, "build", lane));
        }
        "docker_image_update_check" => {
            let target = str_param(params, "reference");
            if let Err(e) = validate_container_id(&target) {
                return Some(failure(id, "invalid_id", e));
            }
            // Local digest first.
            let local = run(
                vec!["docker".into(), "inspect".into(), "--format".into(), "{{index .RepoDigests 0}}".into(), target.clone()],
                None,
            )
            .map(|o| o.stdout.trim().to_string())
            .unwrap_or_default();
            let local_digest = local.split('@').nth(1).unwrap_or("").to_string();
            // Registry manifest digests.
            let manifest = run(
                vec!["docker".into(), "manifest".into(), "inspect".into(), target.clone()],
                None,
            );
            let digests: Vec<String> = match manifest {
                Ok(o) if o.exit_code == Some(0) => {
                    let v: Value = serde_json::from_str(&o.stdout).unwrap_or(Value::Null);
                    // Multi-arch: manifests[].digest; single: config.digest.
                    let mut ds: Vec<String> = v
                        .get("manifests")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(|m| m.get("digest").and_then(Value::as_str).map(str::to_string)).collect())
                        .unwrap_or_default();
                    if ds.is_empty() {
                        if let Some(d) = v.get("config").and_then(|c| c.get("digest")).and_then(Value::as_str) {
                            ds.push(d.to_string());
                        }
                    }
                    ds
                }
                _ => Vec::new(),
            };
            ok(
                id,
                json!({
                    "reference": target,
                    "localDigest": local_digest,
                    "updateAvailable": registry_has_update(&local_digest, &digests),
                }),
            )
        }
        "docker_logs_spawn" => {
            return Some(docker_bg_spawn(state, id, params, "logs", lane));
        }
        "docker_logs_poll" => {
            return Some(docker_bg_poll(state, id, params, true, lane));
        }
        "docker_logs_kill" => {
            return Some(docker_bg_kill(state, id, params, true, lane));
        }
        "docker_service_logs" => {
            // One-shot `service logs` (no follow) — follow mode uses logs_spawn via bg.
            let service = str_param(params, "service");
            if let Err(e) = validate_container_id(&service) {
                return Some(failure(id, "invalid_id", e));
            }
            let tail = params.get("tail").and_then(Value::as_u64).unwrap_or(200);
            match run(
                vec!["docker".into(), "service".into(), "logs".into(), "--no-task-ids".into(), "--tail".into(), tail.to_string(), service],
                None,
            ) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!({ "output": o.stdout })),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_events_spawn" => {
            return Some(docker_bg_spawn(state, id, params, "events", lane));
        }
        "docker_events_poll" => {
            return Some(docker_bg_poll(state, id, params, false, lane));
        }
        "docker_events_kill" => {
            return Some(docker_bg_kill(state, id, params, false, lane));
        }
        "docker_compose_detect" => {
            let dir = str_param(params, "dir");
            let root = PathBuf::from(&dir);
            if !authorized(&root) {
                return Some(denied(id));
            }
            let mut found: Vec<String> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&root) {
                for entry in rd.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if COMPOSE_FILENAMES.contains(&name.as_str()) {
                        found.push(entry.path().to_string_lossy().into_owned());
                    }
                }
            }
            ok(id, json!({ "files": found }))
        }
        "docker_compose_ps" | "docker_compose_config" => {
            let (files_res, project_dir, use_v2) = compose_ctx(params, &authorized, &denied, &id);
            let files = match files_res {
                Ok(f) => f,
                Err(resp) => return Some(resp),
            };
            let mut argv = with_files(compose_prefix(use_v2), &files);
            if !project_dir.is_empty() {
                argv.push("--project-directory".into());
                argv.push(project_dir);
            }
            if method == "docker_compose_ps" {
                argv.extend(["ps".into(), "--format".into(), "json".into()]);
            } else {
                argv.push("config".into());
            }
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => {
                    if method == "docker_compose_ps" {
                        ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout)))
                    } else {
                        ok(id, json!({ "config": o.stdout }))
                    }
                }
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_compose_profiles" => {
            let (files_res, project_dir, use_v2) = compose_ctx(params, &authorized, &denied, &id);
            let files = match files_res {
                Ok(f) => f,
                Err(resp) => return Some(resp),
            };
            let mut argv = with_files(compose_prefix(use_v2), &files);
            if !project_dir.is_empty() {
                argv.push("--project-directory".into());
                argv.push(project_dir);
            }
            argv.extend(["config".into(), "--profiles".into()]);
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => {
                    let profiles = o
                        .stdout
                        .lines()
                        .map(|l| l.trim().to_string())
                        .filter(|l| !l.is_empty())
                        .collect::<Vec<_>>();
                    ok(id, json!({ "profiles": profiles }))
                }
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_compose_up" | "docker_compose_down" | "docker_compose_restart" | "docker_compose_pull" | "docker_compose_build" => {
            let (files_res, project_dir, use_v2) = compose_ctx(params, &authorized, &denied, &id);
            let files = match files_res {
                Ok(f) => f,
                Err(resp) => return Some(resp),
            };
            let mut argv = with_files(compose_prefix(use_v2), &files);
            if !project_dir.is_empty() {
                argv.push("--project-directory".into());
                argv.push(project_dir);
            }
            // Profiles are a deny-by-default config gate: only enable the
            // ones the desktop explicitly selected. Unvalidated profile
            // strings must never reach argv.
            for p in &str_list(params, "profiles") {
                if p.is_empty()
                    || p.len() > 64
                    || !p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                {
                    return Some(failure(id, "invalid_profile", format!("bad profile name: {p}")));
                }
                argv.push("--profile".into());
                argv.push(p.clone());
            }
            match method {
                "docker_compose_up" => {
                    argv.push("up".into());
                    argv.push("-d".into());
                    if bool_param(params, "build") {
                        argv.push("--build".into());
                    }
                }
                "docker_compose_down" => {
                    argv.push("down".into());
                    if bool_param(params, "volumes") {
                        argv.push("-v".into());
                    }
                }
                "docker_compose_restart" => {
                    argv.push("restart".into());
                }
                "docker_compose_pull" => {
                    argv.push("pull".into());
                }
                _ => {
                    argv.push("build".into());
                }
            }
            let services = str_list(params, "services");
            for s in &services {
                if s.is_empty() || s.len() > 128 || !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                    return Some(failure(id, "invalid_service", format!("bad service name: {s}")));
                }
            }
            argv.extend(services);
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_compose_logs" => {
            return Some(docker_bg_spawn(state, id, params, "compose-logs", lane));
        }
        "docker_swarm_info" => {
            match run(vec!["docker".into(), "info".into(), "--format".into(), "json".into()], None) {
                Ok(o) if o.exit_code == Some(0) => {
                    let v: Value = serde_json::from_str(&o.stdout).unwrap_or(Value::Null);
                    ok(id, json!(v.get("Swarm").cloned().unwrap_or(Value::Null)))
                }
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_node_ls" => {
            match run(vec!["docker".into(), "node".into(), "ls".into(), "--format".into(), "json".into()], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_node_update" | "docker_node_promote" | "docker_node_demote" => {
            let node = str_param(params, "node");
            if let Err(e) = validate_container_id(&node) {
                return Some(failure(id, "invalid_id", e));
            }
            let argv = match method {
                "docker_node_update" => {
                    let availability = str_param(params, "availability");
                    if !["active", "pause", "drain"].contains(&availability.as_str()) {
                        return Some(failure(id, "invalid_arg", format!("bad availability: {availability}")));
                    }
                    vec!["docker".into(), "node".into(), "update".into(), "--availability".into(), availability, node]
                }
                "docker_node_promote" => vec!["docker".into(), "node".into(), "promote".into(), node],
                _ => vec!["docker".into(), "node".into(), "demote".into(), node],
            };
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_swarm_init" => {
            let mut argv = vec!["docker".into(), "swarm".into(), "init".into()];
            let addr = str_param(params, "advertiseAddr");
            if !addr.is_empty() {
                if addr.len() > 253 || addr.contains([' ', '\t', '\n', '\r']) {
                    return Some(failure(id, "invalid_arg", "bad advertise addr".into()));
                }
                argv.push("--advertise-addr".into());
                argv.push(addr);
            }
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_swarm_join" => {
            // Join token arrives from the frontend keyring flow; accepted only
            // over the token-authenticated channel, never logged.
            let token = str_param(params, "token");
            let addr = str_param(params, "addr");
            if token.is_empty() || addr.is_empty() || addr.contains([' ', '\t', '\n', '\r']) {
                return Some(failure(id, "invalid_arg", "token and addr required".into()));
            }
            match run(vec!["docker".into(), "swarm".into(), "join".into(), "--token".into(), token, addr], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_swarm_leave" => {
            let mut argv = vec!["docker".into(), "swarm".into(), "leave".into()];
            if bool_param(params, "force") {
                argv.push("--force".into());
            }
            match run(argv, None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_service_ls" => {
            match run(vec!["docker".into(), "service".into(), "ls".into(), "--format".into(), "json".into()], None) {
                Ok(o) if o.exit_code == Some(0) => {
                    let mut services = terax_core::docker::parse_json_lines(&o.stdout);
                    // Annotate replica health server-side so the panel gets it for free.
                    for s in &mut services {
                        let reps = s.get("Replicas").and_then(Value::as_str).unwrap_or("0/0");
                        let health = parse_replicas(reps);
                        s["replicaHealth"] = json!({ "running": health.running, "desired": health.desired, "underReplicated": health.under_replicated() });
                    }
                    ok(id, json!(services))
                }
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_service_inspect" => {
            let target = str_param(params, "id");
            if let Err(e) = validate_container_id(&target) {
                return Some(failure(id, "invalid_id", e));
            }
            match run(vec!["docker".into(), "service".into(), "inspect".into(), target], None) {
                Ok(o) if o.exit_code == Some(0) => {
                    let v: Value = serde_json::from_str(o.stdout.trim()).unwrap_or(Value::Null);
                    ok(id, v)
                }
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_service_ps" => {
            let target = str_param(params, "id");
            if let Err(e) = validate_container_id(&target) {
                return Some(failure(id, "invalid_id", e));
            }
            match run(vec!["docker".into(), "service".into(), "ps".into(), "--format".into(), "json".into(), "--no-trunc".into(), target], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_service_scale" => {
            let service = str_param(params, "service");
            if let Err(e) = validate_container_id(&service) {
                return Some(failure(id, "invalid_id", e));
            }
            let replicas = params.get("replicas").and_then(Value::as_u64).unwrap_or(u64::MAX);
            if replicas > 1024 {
                return Some(failure(id, "invalid_arg", "replicas out of range".into()));
            }
            match run(vec!["docker".into(), "service".into(), "scale".into(), format!("{service}={replicas}")], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_service_update" => {
            let service = str_param(params, "service");
            if let Err(e) = validate_container_id(&service) {
                return Some(failure(id, "invalid_id", e));
            }
            let image = str_param(params, "image");
            // Bounded surface: image swaps and force re-pulls. A force
            // update (`--force`, no spec change) restarts every replica —
            // the swarm equivalent of a rolling container restart.
            if bool_param(params, "force") {
                match run(vec!["docker".into(), "service".into(), "update".into(), "--force".into(), service], None) {
                    Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                    Ok(o) => docker_err(id, &o),
                    Err(e) => failure(id, "docker_error", e),
                }
            } else {
                if image.is_empty() {
                    return Some(failure(id, "invalid_arg", "image required".into()));
                }
                if let Err(e) = validate_container_id(&image) {
                    return Some(failure(id, "invalid_id", e));
                }
                match run(vec!["docker".into(), "service".into(), "update".into(), "--image".into(), image, service], None) {
                    Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                    Ok(o) => docker_err(id, &o),
                    Err(e) => failure(id, "docker_error", e),
                }
            }
        }
        "docker_service_rm" => {
            let service = str_param(params, "service");
            if let Err(e) = validate_container_id(&service) {
                return Some(failure(id, "invalid_id", e));
            }
            match run(vec!["docker".into(), "service".into(), "rm".into(), service], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_service_rollback" => {
            let service = str_param(params, "service");
            if let Err(e) = validate_container_id(&service) {
                return Some(failure(id, "invalid_id", e));
            }
            match run(vec!["docker".into(), "service".into(), "rollback".into(), service], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_stack_ls" => {
            match run(vec!["docker".into(), "stack".into(), "ls".into(), "--format".into(), "json".into()], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_stack_services" => {
            let stack = str_param(params, "stack");
            if stack.is_empty() || stack.len() > 128 || !stack.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                return Some(failure(id, "invalid_id", format!("bad stack name: {stack}")));
            }
            match run(vec!["docker".into(), "stack".into(), "services".into(), "--format".into(), "json".into(), stack], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_stack_tasks" => {
            let stack = str_param(params, "stack");
            if stack.is_empty() || stack.len() > 128 || !stack.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                return Some(failure(id, "invalid_id", format!("bad stack name: {stack}")));
            }
            match run(vec!["docker".into(), "stack".into(), "ps".into(), "--format".into(), "json".into(), "--no-trunc".into(), stack], None) {
                Ok(o) if o.exit_code == Some(0) => {
                    let mut tasks = terax_core::docker::parse_json_lines(&o.stdout);
                    // Annotate task health server-side so a stack card gets a
                    // full picture from one RPC: current state per task plus
                    // per-service running/desired rollup.
                    for t in &mut tasks {
                        t["taskHealthy"] = json!(task_healthy(t));
                    }
                    ok(id, json!(tasks))
                }
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_stack_ps" => {
            let stack = str_param(params, "stack");
            if stack.is_empty() || stack.len() > 128 || !stack.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                return Some(failure(id, "invalid_id", format!("bad stack name: {stack}")));
            }
            match run(vec!["docker".into(), "stack".into(), "ps".into(), "--format".into(), "json".into(), stack], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_stack_deploy" | "docker_stack_rm" => {
            let stack = str_param(params, "stack");
            if stack.is_empty() || stack.len() > 128 || !stack.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                return Some(failure(id, "invalid_id", format!("bad stack name: {stack}")));
            }
            if method == "docker_stack_rm" {
                match run(vec!["docker".into(), "stack".into(), "rm".into(), stack], None) {
                    Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                    Ok(o) => docker_err(id, &o),
                    Err(e) => failure(id, "docker_error", e),
                }
            } else {
                let file = str_param(params, "composeFile");
                let fpath = PathBuf::from(&file);
                if !authorized(&fpath) {
                    return Some(denied(id));
                }
                match run(vec!["docker".into(), "stack".into(), "deploy".into(), "-c".into(), file, stack], None) {
                    Ok(o) if o.exit_code == Some(0) => ok(id, json!(o.stdout)),
                    Ok(o) => docker_err(id, &o),
                    Err(e) => failure(id, "docker_error", e),
                }
            }
        }
        "docker_secret_ls" => {
            match run(vec!["docker".into(), "secret".into(), "ls".into(), "--format".into(), "json".into()], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_secret_create" => {
            // Secret value arrives over the token-authenticated channel and
            // is piped via stdin — never argv, never logged.
            let name = str_param(params, "name");
            let value = str_param(params, "value");
            if name.is_empty() || name.len() > 128 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                return Some(failure(id, "invalid_id", format!("bad secret name: {name}")));
            }
            if value.is_empty() {
                return Some(failure(id, "invalid_arg", "secret value required".into()));
            }
            let mut cmd = std::process::Command::new("docker");
            cmd.arg("secret").arg("create").arg(&name).arg("-")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => return Some(failure(id, "docker_error", e.to_string())),
            };
            use std::io::Write;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(value.as_bytes());
            }
            match child.wait_with_output() {
                Ok(o) if o.status.success() => ok(id, json!(null)),
                Ok(o) => failure(id, "docker_error", String::from_utf8_lossy(&o.stderr).trim().to_string()),
                Err(e) => failure(id, "docker_error", e.to_string()),
            }
        }
        "docker_secret_rm" => {
            let name = str_param(params, "name");
            if name.is_empty() || name.len() > 128 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                return Some(failure(id, "invalid_id", format!("bad secret name: {name}")));
            }
            match run(vec!["docker".into(), "secret".into(), "rm".into(), name], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_config_ls" => {
            match run(vec!["docker".into(), "config".into(), "ls".into(), "--format".into(), "json".into()], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(terax_core::docker::parse_json_lines(&o.stdout))),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_config_create" => {
            let name = str_param(params, "name");
            let file = str_param(params, "file");
            if name.is_empty() || name.len() > 128 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                return Some(failure(id, "invalid_id", format!("bad config name: {name}")));
            }
            let fpath = PathBuf::from(&file);
            if !authorized(&fpath) {
                return Some(denied(id));
            }
            match run(vec!["docker".into(), "config".into(), "create".into(), name, file], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_config_rm" => {
            let name = str_param(params, "name");
            if name.is_empty() || name.len() > 128 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                return Some(failure(id, "invalid_id", format!("bad config name: {name}")));
            }
            match run(vec!["docker".into(), "config".into(), "rm".into(), name], None) {
                Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                Ok(o) => docker_err(id, &o),
                Err(e) => failure(id, "docker_error", e),
            }
        }
        "docker_cp_to" | "docker_cp_from" => {
            if method == "docker_cp_to" {
                let src = str_param(params, "src");
                let container = str_param(params, "container");
                let dest = str_param(params, "dest");
                if let Err(e) = validate_container_id(&container) {
                    return Some(failure(id, "invalid_id", e));
                }
                let spath = PathBuf::from(&src);
                if !authorized(&spath) {
                    return Some(denied(id));
                }
                if dest.is_empty() || dest.contains('\0') {
                    return Some(failure(id, "invalid_arg", "bad container path".into()));
                }
                match run(vec!["docker".into(), "cp".into(), src, format!("{container}:{dest}")], None) {
                    Ok(o) if o.exit_code == Some(0) => ok(id, json!(null)),
                    Ok(o) => docker_err(id, &o),
                    Err(e) => failure(id, "docker_error", e),
                }
            } else {
                return Some(failure(id, "not_implemented", "cp-from downloads land in M2".into()));
            }
        }
        _ => return None,
    })
}

fn compose_ctx(
    params: &Value,
    authorized: &impl Fn(&PathBuf) -> bool,
    denied: &impl Fn(String) -> ControlResponse,
    id: &str,
) -> (Result<Vec<String>, ControlResponse>, String, bool) {
    let files = str_list(params, "files");
    if files.is_empty() {
        return (Err(denied(id.to_string())), String::new(), true);
    }
    for f in &files {
        if !authorized(&PathBuf::from(f)) {
            return (Err(denied(id.to_string())), String::new(), true);
        }
    }
    let project_dir = opt_str(params, "projectDir").unwrap_or_default();
    if !project_dir.is_empty() && !authorized(&PathBuf::from(&project_dir)) {
        return (Err(denied(id.to_string())), String::new(), true);
    }
    let use_v2 = params.get("composeV2").and_then(Value::as_bool).unwrap_or(true);
    (Ok(files), project_dir, use_v2)
}

/// Spawn a background docker proc (pull / build / logs -f / events / compose
/// logs) into the ring buffer; the frontend polls by handle within the
/// request's v3 lane namespace.
fn docker_bg_spawn(
    state: &DockerShared,
    id: String,
    params: &Value,
    kind: &str,
    lane: Option<u8>,
) -> ControlResponse {
    let argv: Vec<String> = match kind {
        "pull" => {
            let reference = str_param(params, "reference");
            if let Err(e) = validate_container_id(&reference) {
                return failure(id, "invalid_id", e);
            }
            let mut v = vec!["docker".into(), "pull".into()];
            if !str_param(params, "platform").is_empty() {
                v.push("--platform".into());
                v.push(str_param(params, "platform"));
            }
            if bool_param(params, "quiet") {
                v.push("-q".into());
            }
            v.push(reference);
            v
        }
        "build" => {
            return failure(id, "not_implemented", "docker build lands in M2".into());
        }
        "logs" => {
            let container = str_param(params, "container");
            if let Err(e) = validate_container_id(&container) {
                return failure(id, "invalid_id", e);
            }
            let mut v = vec!["docker".into(), "logs".into(), "-f".into()];
            if bool_param(params, "timestamps") {
                v.push("--timestamps".into());
            }
            let tail = params.get("tail").and_then(Value::as_u64).unwrap_or(500);
            v.push("--tail".into());
            v.push(tail.min(10000).to_string());
            if !str_param(params, "since").is_empty() {
                v.push("--since".into());
                v.push(str_param(params, "since"));
            }
            v.push(container);
            v
        }
        "events" => {
            let mut v = vec!["docker".into(), "events".into(), "--format".into(), "json".into()];
            if !str_param(params, "filter").is_empty() {
                v.push("--filter".into());
                v.push(str_param(params, "filter"));
            }
            v
        }
        "compose-logs" => {
            let files = str_list(params, "files");
            if files.is_empty() {
                return failure(id, "invalid_arg", "compose files required".into());
            }
            // authorized() is checked by the caller route for compose-logs.
            let use_v2 = params.get("composeV2").and_then(Value::as_bool).unwrap_or(true);
            let mut v = with_files(compose_prefix(use_v2), &files);
            v.extend(["logs".into(), "-f".into(), "--tail".into(), "500".into()]);
            v.extend(str_list(params, "services"));
            v
        }
        _ => return failure(id, "invalid_kind", format!("unknown bg kind: {kind}")),
    };
    match terax_core::shell::background::spawn_argv(argv, None) {
        Ok(proc) => {
            let is_logs = kind == "logs" || kind == "compose-logs" || kind == "events";
            let handle = state.lane_insert(lane, is_logs, proc.clone());
            let info = proc.info(handle);
            ok(id, json!(info))
        }
        Err(e) => failure(id, "docker_error", e),
    }
}

fn docker_bg_poll(
    state: &DockerShared,
    id: String,
    params: &Value,
    is_logs: bool,
    lane: Option<u8>,
) -> ControlResponse {
    let handle = params.get("handle").and_then(Value::as_u64).unwrap_or(0) as u32;
    let Some(proc) = state.lane_get(lane, is_logs, handle) else {
        return failure(id, "no_handle", "no background handle".to_string());
    };
    let since = params.get("sinceOffset").and_then(Value::as_u64).unwrap_or(0);
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .map(|l| (l as usize).clamp(1024, terax_control_protocol::MAX_POLL_BYTES))
        .unwrap_or(terax_control_protocol::MAX_POLL_BYTES);
    let mut resp = json!(proc.read_logs_capped(since, limit));
    // Parse pull progress lines server-side so the UI gets structured events.
    // (Pull procs live in the events map; logs keep the raw ring buffer.)
    if !is_logs {
        if let Some(bytes) = resp.get("bytes").and_then(Value::as_str).map(str::to_string) {
            let events: Vec<PullProgressEvent> = bytes
                .lines()
                .filter_map(parse_pull_progress_line)
                .collect();
            resp["events"] = json!(events);
        }
    }
    ok(id, resp)
}

fn docker_bg_kill(
    state: &DockerShared,
    id: String,
    params: &Value,
    is_logs: bool,
    lane: Option<u8>,
) -> ControlResponse {
    let handle = params.get("handle").and_then(Value::as_u64).unwrap_or(0) as u32;
    if let Some(proc) = state.lane_get(lane, is_logs, handle) {
        proc.kill();
    }
    ok(id, json!(null))
}

use terax_core::docker::PullProgressEvent;
