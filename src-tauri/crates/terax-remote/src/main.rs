use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use terax_control_protocol::{
    ControlRequest, ControlResponse, REMOTE_METHODS, REMOTE_METHOD_FS_COPY,
    REMOTE_METHOD_FS_CREATE_DIR, REMOTE_METHOD_FS_CREATE_FILE, REMOTE_METHOD_FS_DELETE,
    REMOTE_METHOD_FS_DELETE_BATCH, REMOTE_METHOD_FS_GREP, REMOTE_METHOD_FS_MOVE,
    REMOTE_METHOD_FS_RENAME,
    REMOTE_METHOD_FS_READ_DIR, REMOTE_METHOD_FS_READ_FILE, REMOTE_METHOD_FS_READ_BYTES, REMOTE_METHOD_FS_SEARCH,
    REMOTE_METHOD_FS_STAT, REMOTE_METHOD_FS_WRITE_FILE, REMOTE_METHOD_GIT_CHECKOUT_BRANCH,
    REMOTE_METHOD_GIT_COMMIT, REMOTE_METHOD_GIT_COMMIT_FILES, REMOTE_METHOD_GIT_COMMIT_FILE_DIFF,
    REMOTE_METHOD_GIT_DIFF, REMOTE_METHOD_GIT_DIFF_CONTENT, REMOTE_METHOD_GIT_DISCARD,
    REMOTE_METHOD_GIT_FETCH, REMOTE_METHOD_GIT_LIST_BRANCHES, REMOTE_METHOD_GIT_LOG,
    REMOTE_METHOD_GIT_PANEL_SNAPSHOT, REMOTE_METHOD_GIT_PULL_FF_ONLY, REMOTE_METHOD_GIT_PUSH,
    REMOTE_METHOD_GIT_REMOTE_URL, REMOTE_METHOD_GIT_RESOLVE_REPO, REMOTE_METHOD_GIT_SHOW_COMMIT,
    REMOTE_METHOD_GIT_STAGE, REMOTE_METHOD_GIT_STATUS, REMOTE_METHOD_GIT_UNSTAGE,
    REMOTE_METHOD_SHELL_BG_KILL, REMOTE_METHOD_SHELL_BG_LOGS, REMOTE_METHOD_SHELL_BG_SPAWN,
    REMOTE_METHOD_SHELL_RUN, REMOTE_METHOD_SHELL_SESSION_CLOSE, REMOTE_METHOD_SHELL_SESSION_OPEN,
    REMOTE_METHOD_SHELL_SESSION_RUN, REMOTE_PROTOCOL_VERSION,
};
use terax_core::workspace::{WorkspaceEnv, WorkspaceRegistry};

mod auth;
mod docker;

/// One background-handle namespace: an isolated handle map plus its own
/// counter, so two follows in different lanes never share handle ids.
/// Lanes are append-only (created on first use, never removed).
struct LaneBg {
    map: Mutex<HashMap<u32, Arc<terax_core::shell::background::BackgroundProc>>>,
    next: AtomicU32,
}

impl Default for LaneBg {
    fn default() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            next: AtomicU32::new(1),
        }
    }
}

impl LaneBg {
    fn spawn(&self, proc: Arc<terax_core::shell::background::BackgroundProc>) -> u32 {
        let handle = self.next.fetch_add(1, Ordering::Relaxed);
        self.map.lock().unwrap().insert(handle, proc);
        handle
    }

    fn get(&self, handle: u32) -> Option<Arc<terax_core::shell::background::BackgroundProc>> {
        self.map.lock().unwrap().get(&handle).cloned()
    }
}

struct Agent {
    registry: WorkspaceRegistry,
    root: PathBuf,
    sessions: Mutex<HashMap<u32, Arc<terax_core::shell::session::ShellSession>>>,
    /// v3 lane namespaces for shell bg procs. Lane 0 is the legacy default:
    /// pre-v3 clients that send no lane resolve here, preserving the old
    /// shared-map behavior exactly.
    bg_lanes: Mutex<HashMap<u8, LaneBg>>,
    next_session: AtomicU32,
    docker: docker::DockerShared,
}

impl Agent {}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("terax-remote {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let mut root: Option<String> = None;
    let mut token: Option<String> = None;
    let mut iter = args.iter().skip(1).peekable();
    let mut serve = false;
    while let Some(a) = iter.next() {
        match a.as_str() {
            "serve" => serve = true,
            "--root" => root = iter.next().cloned(),
            "--token" => token = iter.next().cloned(),
            _ => {}
        }
    }
    if !serve {
        eprintln!("Usage: terax-remote serve --root <path> --token <hex>");
        eprintln!("Serves Terax remote requests on stdin/stdout (newline-delimited JSON).");
        std::process::exit(2);
    }
    let root = root.unwrap_or_else(|| {
        eprintln!("terax-remote serve requires --root");
        std::process::exit(2);
    });
    let token = token.unwrap_or_else(|| {
        eprintln!("terax-remote serve requires --token");
        std::process::exit(2);
    });
    serve_root(root, token);
}

fn serve_root(root: String, token: String) {
    let registry = WorkspaceRegistry::default();
    let canonical = registry.authorize(&root).unwrap_or_else(|e| {
        eprintln!("cannot authorize root {root}: {e}");
        std::process::exit(2);
    });
    let agent = Agent {
        registry,
        root: canonical,
        sessions: Mutex::new(HashMap::new()),
        bg_lanes: Mutex::new(HashMap::new()),
        next_session: AtomicU32::new(1),
        docker: docker::DockerShared::default(),
    };
    auth::expect_token(&token);
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut stdout = std::io::stdout().lock();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let response = agent.handle_line(&line);
        let mut bytes = serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec());
        bytes.push(b'\n');
        if stdout.write_all(&bytes).is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

fn local_env() -> WorkspaceEnv {
    WorkspaceEnv::Local
}

impl Agent {
    fn handle_line(&self, line: &str) -> ControlResponse {
        let request: ControlRequest = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                return ControlResponse::failure(
                    terax_control_protocol::SERVER_RESPONSE_ID,
                    "invalid_json",
                    format!("invalid request JSON: {e}"),
                );
            }
        };
        if request.protocol != REMOTE_PROTOCOL_VERSION {
            return ControlResponse::failure(
                request.id,
                "unsupported_protocol",
                format!(
                    "protocol {} unsupported; expected {REMOTE_PROTOCOL_VERSION}",
                    request.protocol
                ),
            );
        }
        if !auth::check_token(&request.token) {
            return ControlResponse::failure(request.id, "unauthorized", "invalid token");
        }
        self.route(request)
    }

    fn route(&self, request: ControlRequest) -> ControlResponse {
        let params = request.params.clone();
        // Docker routes live in docker.rs; thin dispatch only here.
        if request.method.starts_with("docker_") {
            let authorized = |p: &PathBuf| self.authorized(p);
            let id = request.id.clone();
            let lane = request.lane;
            if let Some(resp) = docker::handle_docker(&self.docker, &request.method, id, &params, authorized, lane) {
                return resp;
            }
            return ControlResponse::failure(request.id, "unknown_method", "unknown remote method");
        }
        let get = |k: &str| params.get(k).cloned().unwrap_or(Value::Null);
        let str_param = |k: &str| get(k).as_str().unwrap_or("").to_string();
        match request.method.as_str() {
            "ping" => ControlResponse::success(
                request.id,
                json!({ "pong": true, "app_version": env!("CARGO_PKG_VERSION"), "protocol": REMOTE_PROTOCOL_VERSION }),
            ),
            "capabilities" => ControlResponse::success(
                request.id,
                json!({
                    "app_version": env!("CARGO_PKG_VERSION"),
                    "protocol": REMOTE_PROTOCOL_VERSION,
                    "methods": REMOTE_METHODS,
                }),
            ),
            REMOTE_METHOD_FS_READ_DIR => {
                let root = PathBuf::from(str_param("path"));
                if !self.authorized(&root) {
                    return denied(request.id);
                }
                match terax_core::fs::read_dir_entries(&root, bool_param(&params, "showHidden"), bool_param(&params, "gitDecorations")) {
                    Ok(entries) => ControlResponse::success(request.id, json!(entries)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_READ_FILE => {
                let path = PathBuf::from(str_param("path"));
                if !self.authorized(&path) {
                    return denied(request.id);
                }
                match terax_core::fs::file::read_file_sync(&path, bool_param(&params, "force")) {
                    Ok(res) => ControlResponse::success(request.id, json!(res)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_READ_BYTES => {
                let path = PathBuf::from(str_param("path"));
                if !self.authorized(&path) {
                    return denied(request.id);
                }
                match terax_core::fs::file::read_bytes_sync(&path) {
                    Ok(res) => ControlResponse::success(request.id, json!(res)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_WRITE_FILE => {
                let path = PathBuf::from(str_param("path"));
                if !self.authorized(&path) {
                    return denied(request.id);
                }
                let content = str_param("content");
                match terax_core::fs::file::write_file_sync(&path, content.as_bytes()) {
                    Ok(mtime) => ControlResponse::success(request.id, json!(mtime)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_STAT => {
                let path = PathBuf::from(str_param("path"));
                if !self.authorized(&path) {
                    return denied(request.id);
                }
                match terax_core::fs::file::stat_sync(&path) {
                    Ok(stat) => ControlResponse::success(request.id, json!(stat)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_CREATE_FILE | REMOTE_METHOD_FS_CREATE_DIR => {
                let path = PathBuf::from(str_param("path"));
                if !self.authorized(&path) {
                    return denied(request.id);
                }
                let out = if request.method == REMOTE_METHOD_FS_CREATE_FILE {
                    terax_core::fs::mutate::create_file(&path)
                } else {
                    terax_core::fs::mutate::create_dir(&path)
                };
                match out {
                    Ok(_) => ControlResponse::success(request.id, json!(null)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_RENAME => {
                let from = PathBuf::from(str_param("from"));
                let to = PathBuf::from(str_param("to"));
                if !self.authorized(&from) || !self.authorized(&to) {
                    return denied(request.id);
                }
                match terax_core::fs::mutate::rename_path(&from, &to) {
                    Ok(_) => ControlResponse::success(request.id, json!(null)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_DELETE => {
                let path = PathBuf::from(str_param("path"));
                if !self.authorized(&path) {
                    return denied(request.id);
                }
                match terax_core::fs::mutate::delete_path(&path) {
                    Ok(_) => ControlResponse::success(request.id, json!(null)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_DELETE_BATCH => {
                let root = PathBuf::from(str_param("root"));
                if !self.authorized(&root) {
                    return denied(request.id);
                }
                let paths: Vec<String> = params
                    .get("paths")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let resolved: Vec<(String, PathBuf)> = paths
                    .into_iter()
                    .map(|p| {
                        let r = PathBuf::from(&p);
                        (p, r)
                    })
                    .collect();
                if resolved.iter().any(|(_, r)| !self.authorized(r)) {
                    return denied(request.id);
                }
                let res = terax_core::fs::mutate::delete_batch(resolved, &root);
                ControlResponse::success(request.id, json!(res))
            }
            REMOTE_METHOD_FS_MOVE => {
                let root = PathBuf::from(str_param("root"));
                let from = PathBuf::from(str_param("from"));
                let to = PathBuf::from(str_param("to"));
                if !self.authorized(&root) || !self.authorized(&from) || !self.authorized(&to) {
                    return denied(request.id);
                }
                let conflict = opt_str(&params, "expectedConflict");
                match terax_core::fs::mutate::move_paths(&from, &to, &root, conflict.as_deref()) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_COPY => {
                let dest = PathBuf::from(str_param("destDir"));
                if !self.authorized(&dest) {
                    return denied(request.id);
                }
                let sources: Vec<String> = params
                    .get("sources")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                match terax_core::fs::mutate::copy_into(&sources, &dest) {
                    Ok(_) => ControlResponse::success(request.id, json!(null)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_SEARCH => {
                let root = PathBuf::from(str_param("root"));
                if !self.authorized(&root) {
                    return denied(request.id);
                }
                match terax_core::fs::search::search_files(
                    &root,
                    &root.to_string_lossy(),
                    true,
                    &str_param("query"),
                    num_param(&params, "limit", 200),
                    bool_param(&params, "showHidden"),
                ) {
                    Ok(res) => ControlResponse::success(request.id, json!(res)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_FS_GREP => {
                let root = PathBuf::from(str_param("root"));
                if !self.authorized(&root) {
                    return denied(request.id);
                }
                let globs: Vec<String> = params
                    .get("glob")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                match terax_core::fs::grep::grep_files(
                    &root,
                    &root.to_string_lossy(),
                    true,
                    &str_param("pattern"),
                    &globs,
                    bool_param(&params, "caseInsensitive"),
                    num_param(&params, "maxResults", 200),
                    &|| false,
                ) {
                    Ok(res) => ControlResponse::success(request.id, json!(res)),
                    Err(e) => ControlResponse::failure(request.id, "io_error", e),
                }
            }
            REMOTE_METHOD_GIT_PANEL_SNAPSHOT | REMOTE_METHOD_GIT_STATUS => {
                let cwd = str_param(if request.method == REMOTE_METHOD_GIT_STATUS { "repoRoot" } else { "cwd" });
                let cwd_path = PathBuf::from(&cwd);
                if !self.authorized(&cwd_path) {
                    return denied(request.id);
                }
                let env = local_env();
                let out = if request.method == REMOTE_METHOD_GIT_STATUS {
                    terax_core::git::operations::status(&self.registry, &cwd, &env)
                        .map(|s| json!(s))
                        .map_err(|e| e.to_string())
                } else {
                    terax_core::git::operations::panel_snapshot(&self.registry, &cwd, &env)
                        .map(|s| json!(s))
                        .map_err(|e| e.to_string())
                };
                match out {
                    Ok(v) => ControlResponse::success(request.id, v),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e),
                }
            }
            REMOTE_METHOD_GIT_RESOLVE_REPO => {
                let cwd = str_param("cwd");
                if !self.authorized(&PathBuf::from(&cwd)) {
                    return denied(request.id);
                }
                match terax_core::git::operations::resolve_repo(&self.registry, &cwd, &local_env()) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_DIFF => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                let path = opt_str(&params, "path");
                let staged = bool_param(&params, "staged");
                match terax_core::git::operations::diff(&self.registry, &repo_root, path.as_deref(), staged, &local_env()) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_STAGE | REMOTE_METHOD_GIT_UNSTAGE => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                let paths: Vec<String> = params
                    .get("paths")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let env = local_env();
                let out = if request.method == REMOTE_METHOD_GIT_STAGE {
                    terax_core::git::operations::stage(&self.registry, &repo_root, &paths, &env)
                        .map(|_| json!(null))
                } else {
                    terax_core::git::operations::unstage(&self.registry, &repo_root, &paths, &env)
                        .map(|_| json!(null))
                };
                match out {
                    Ok(v) => ControlResponse::success(request.id, v),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_DISCARD => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                let entries: Vec<terax_core::git::types::DiscardEntry> = params
                    .get("entries")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                match terax_core::git::operations::discard(&self.registry, &repo_root, &entries, &local_env()) {
                    Ok(_) => ControlResponse::success(request.id, json!(null)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_COMMIT => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                match terax_core::git::operations::commit(&self.registry, &repo_root, &str_param("message"), &local_env()) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_LOG => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                let limit = opt_num(&params, "limit", 100);
                let before = opt_str(&params, "beforeSha");
                match terax_core::git::operations::log(&self.registry, &repo_root, limit, before.as_deref(), &local_env()) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_SHELL_RUN => {
                let cwd = str_param("cwd");
                if !cwd.is_empty() && !self.authorized(&PathBuf::from(&cwd)) {
                    return denied(request.id);
                }
                let timeout_secs = (num_param(&params, "timeoutSecs", 30) as u64).clamp(1, 300);
                let timeout = Duration::from_secs(timeout_secs);
                let cwd_opt = if cwd.is_empty() { None } else { Some(cwd) };
                match terax_core::shell::run_blocking(str_param("command"), cwd_opt, timeout) {
                    Ok(out) => ControlResponse::success(request.id, json!(out)),
                    Err(e) => ControlResponse::failure(request.id, "shell_error", e),
                }
            }
            REMOTE_METHOD_SHELL_SESSION_OPEN => {
                let cwd = opt_str(&params, "cwd").filter(|s| !s.is_empty());
                if let Some(ref dir) = cwd {
                    if !self.authorized(&PathBuf::from(dir)) {
                        return denied(request.id);
                    }
                }
                let initial = cwd.unwrap_or_else(|| self.root.to_string_lossy().into_owned());
                let session = Arc::new(terax_core::shell::session::ShellSession::new(initial));
                let id = self.next_session.fetch_add(1, Ordering::Relaxed);
                self.sessions.lock().unwrap().insert(id, session);
                ControlResponse::success(request.id, json!(id))
            }
            REMOTE_METHOD_SHELL_SESSION_RUN => {
                let id = num_param(&params, "id", 0) as u32;
                let session = self.sessions.lock().unwrap().get(&id).cloned();
                let Some(session) = session else {
                    return ControlResponse::failure(request.id, "no_session", "no shell session");
                };
                let cwd = opt_str(&params, "cwd").filter(|s| !s.is_empty());
                if let Some(ref dir) = cwd {
                    if !self.authorized(&PathBuf::from(dir)) {
                        return denied(request.id);
                    }
                }
                let timeout = Duration::from_secs((num_param(&params, "timeoutSecs", 30) as u64).clamp(1, 300));
                match session.run(str_param("command"), cwd, timeout) {
                    Ok(out) => ControlResponse::success(request.id, json!(out)),
                    Err(e) => ControlResponse::failure(request.id, "shell_error", e),
                }
            }
            REMOTE_METHOD_SHELL_SESSION_CLOSE => {
                let id = num_param(&params, "id", 0) as u32;
                self.sessions.lock().unwrap().remove(&id);
                ControlResponse::success(request.id, json!(null))
            }
            REMOTE_METHOD_SHELL_BG_SPAWN => {
                let cwd = opt_str(&params, "cwd").filter(|s| !s.is_empty());
                if let Some(ref dir) = cwd {
                    if !self.authorized(&PathBuf::from(dir)) {
                        return denied(request.id);
                    }
                }
                match terax_core::shell::background::spawn(str_param("command"), cwd) {
                    Ok(proc) => {
                        // Hold the lanes lock only for namespace lookup;
                        // spawn inserts under the lane's own map lock.
                        let handle = {
                            let mut lanes = self.bg_lanes.lock().unwrap();
                            lanes.entry(request.lane.unwrap_or(0)).or_default().spawn(proc.clone())
                        };
                        let info = proc.info(handle);
                        ControlResponse::success(request.id, json!(info))
                    }
                    Err(e) => ControlResponse::failure(request.id, "shell_error", e),
                }
            }
            REMOTE_METHOD_SHELL_BG_LOGS => {
                let handle = num_param(&params, "handle", 0) as u32;
                let proc = {
                    let mut lanes = self.bg_lanes.lock().unwrap();
                    lanes
                        .entry(request.lane.unwrap_or(0))
                        .or_default()
                        .get(handle)
                };
                let Some(proc) = proc else {
                    return ControlResponse::failure(request.id, "no_handle", "no background handle");
                };
                let since = params.get("sinceOffset").and_then(Value::as_u64).unwrap_or(0);
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|l| (l as usize).clamp(1024, terax_control_protocol::MAX_POLL_BYTES))
                    .unwrap_or(terax_control_protocol::MAX_POLL_BYTES);
                ControlResponse::success(request.id, json!(proc.read_logs_capped(since, limit)))
            }
            REMOTE_METHOD_SHELL_BG_KILL => {
                let handle = num_param(&params, "handle", 0) as u32;
                let proc = {
                    let mut lanes = self.bg_lanes.lock().unwrap();
                    lanes
                        .entry(request.lane.unwrap_or(0))
                        .or_default()
                        .get(handle)
                };
                if let Some(proc) = proc {
                    proc.kill();
                }
                ControlResponse::success(request.id, json!(null))
            }
            REMOTE_METHOD_GIT_DIFF_CONTENT => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                let orig = opt_str(&params, "originalPath");
                match terax_core::git::operations::diff_content(
                    &self.registry,
                    &repo_root,
                    &str_param("path"),
                    bool_param(&params, "staged"),
                    orig.as_deref(),
                    &local_env(),
                ) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_SHOW_COMMIT => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                match terax_core::git::operations::show_commit_diff(
                    &self.registry,
                    &repo_root,
                    &str_param("sha"),
                    &local_env(),
                ) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_COMMIT_FILES => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                match terax_core::git::operations::commit_files(
                    &self.registry,
                    &repo_root,
                    &str_param("sha"),
                    &local_env(),
                ) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_COMMIT_FILE_DIFF => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                let orig = opt_str(&params, "originalPath");
                match terax_core::git::operations::commit_file_diff(
                    &self.registry,
                    &repo_root,
                    &str_param("sha"),
                    &str_param("path"),
                    orig.as_deref(),
                    &local_env(),
                ) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_REMOTE_URL => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                let name = opt_str(&params, "name").unwrap_or_else(|| "origin".to_string());
                match terax_core::git::operations::remote_url(
                    &self.registry,
                    &repo_root,
                    &name,
                    &local_env(),
                ) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_FETCH | REMOTE_METHOD_GIT_PULL_FF_ONLY | REMOTE_METHOD_GIT_PUSH => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                let out = if request.method == REMOTE_METHOD_GIT_FETCH {
                    terax_core::git::operations::fetch(&self.registry, &repo_root, &local_env())
                        .map(|_| json!(null))
                } else if request.method == REMOTE_METHOD_GIT_PULL_FF_ONLY {
                    terax_core::git::operations::pull_ff_only(&self.registry, &repo_root, &local_env())
                        .map(|_| json!(null))
                } else {
                    terax_core::git::operations::push(&self.registry, &repo_root, &local_env())
                        .map(|v| json!(v))
                };
                match out {
                    Ok(v) => ControlResponse::success(request.id, v),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_LIST_BRANCHES => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                match terax_core::git::operations::list_branches(&self.registry, &repo_root, &local_env()) {
                    Ok(v) => ControlResponse::success(request.id, json!(v)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            REMOTE_METHOD_GIT_CHECKOUT_BRANCH => {
                let repo_root = str_param("repoRoot");
                if !self.authorized(&PathBuf::from(&repo_root)) {
                    return denied(request.id);
                }
                match terax_core::git::operations::checkout_branch(
                    &self.registry,
                    &repo_root,
                    &str_param("branch"),
                    &local_env(),
                ) {
                    Ok(_) => ControlResponse::success(request.id, json!(null)),
                    Err(e) => ControlResponse::failure(request.id, "git_error", e.to_string()),
                }
            }
            _ => ControlResponse::failure(request.id, "unknown_method", "unknown remote method"),
        }
    }

    fn authorized(&self, path: &std::path::Path) -> bool {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        canonical.starts_with(&self.root) || self.registry.is_authorized(&canonical)
    }
}

fn denied(id: String) -> ControlResponse {
    ControlResponse::failure(id, "path_not_accessible", "path is outside the authorized workspace")
}

fn bool_param(params: &Value, key: &str) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn num_param(params: &Value, key: &str, default: usize) -> usize {
    params.get(key).and_then(Value::as_u64).map(|v| v as usize).unwrap_or(default)
}

fn opt_str(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

fn opt_num(params: &Value, key: &str, default: u32) -> u32 {
    params.get(key).and_then(Value::as_u64).map(|v| v as u32).unwrap_or(default)
}
