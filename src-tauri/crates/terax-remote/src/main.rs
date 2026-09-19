use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use terax_control_protocol::{
    ControlRequest, ControlResponse, REMOTE_METHODS, REMOTE_METHOD_FS_GREP,
    REMOTE_METHOD_FS_READ_DIR, REMOTE_METHOD_FS_READ_FILE, REMOTE_METHOD_FS_SEARCH,
    REMOTE_METHOD_FS_STAT, REMOTE_METHOD_FS_WRITE_FILE, REMOTE_METHOD_GIT_PANEL_SNAPSHOT,
    REMOTE_METHOD_GIT_STATUS, REMOTE_METHOD_SHELL_RUN, REMOTE_PROTOCOL_VERSION,
};
use terax_core::workspace::{WorkspaceEnv, WorkspaceRegistry};

mod auth;

struct Agent {
    registry: WorkspaceRegistry,
    root: PathBuf,
}

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
