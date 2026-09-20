use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u16 = 1;
/// Protocol version spoken by terax-remote agents. Additive over v1: the
/// local control server stays v1, remote agents advertise v2 capabilities.
///
/// v3 (backwards-compatible framing upgrade, negotiated per connection):
/// - requests may carry `lane` (u8): the agent binds the request's
///   background-handle namespace to that lane, so spawn/poll/kill stay on
///   one agent process even when the desktop round-robins pipes. Lanes are
///   process-local namespaces, not global routing — any pipe serves any
///   lane, and state lazily materializes where first used.
/// - responses to `*_poll` may carry `truncated: true` when the payload was
///   capped to fit `MAX_MESSAGE_BYTES`: the client must re-poll with an
///   explicit `limit`/`sinceOffset` window instead of assuming completeness.
/// - `*_poll` accepts `limit` (max bytes): lets the client bound each
///   chunk under the frame cap without trial and error.
pub const REMOTE_PROTOCOL_VERSION: u16 = 3;
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Max log/event bytes returned per poll response. Kept well under
/// MAX_MESSAGE_BYTES so JSON escaping overhead can never blow the frame.
pub const MAX_POLL_BYTES: usize = 32 * 1024;
pub const METHOD_PING: &str = "ping";
pub const METHOD_CAPABILITIES: &str = "capabilities";
pub const METHOD_IDENTIFY: &str = "identify";
pub const METHOD_OPEN: &str = "open";
pub const SERVER_RESPONSE_ID: &str = "server";
pub const METHODS: &[&str] = &[
    METHOD_PING,
    METHOD_CAPABILITIES,
    METHOD_IDENTIFY,
    METHOD_OPEN,
];

pub const REMOTE_METHOD_FS_READ_DIR: &str = "fs_read_dir";
pub const REMOTE_METHOD_FS_READ_FILE: &str = "fs_read_file";
pub const REMOTE_METHOD_FS_READ_BYTES: &str = "fs_read_bytes";
pub const REMOTE_METHOD_FS_WRITE_FILE: &str = "fs_write_file";
pub const REMOTE_METHOD_FS_STAT: &str = "fs_stat";
pub const REMOTE_METHOD_FS_SEARCH: &str = "fs_search";
pub const REMOTE_METHOD_FS_GREP: &str = "fs_grep";
pub const REMOTE_METHOD_FS_CREATE_FILE: &str = "fs_create_file";
pub const REMOTE_METHOD_FS_CREATE_DIR: &str = "fs_create_dir";
pub const REMOTE_METHOD_FS_RENAME: &str = "fs_rename";
pub const REMOTE_METHOD_FS_DELETE: &str = "fs_delete";
pub const REMOTE_METHOD_FS_DELETE_BATCH: &str = "fs_delete_batch";
pub const REMOTE_METHOD_FS_MOVE: &str = "fs_move";
pub const REMOTE_METHOD_FS_COPY: &str = "fs_copy";
pub const REMOTE_METHOD_GIT_PANEL_SNAPSHOT: &str = "git_panel_snapshot";
pub const REMOTE_METHOD_GIT_STATUS: &str = "git_status";
pub const REMOTE_METHOD_GIT_RESOLVE_REPO: &str = "git_resolve_repo";
pub const REMOTE_METHOD_GIT_DIFF: &str = "git_diff";
pub const REMOTE_METHOD_GIT_DIFF_CONTENT: &str = "git_diff_content";
pub const REMOTE_METHOD_GIT_STAGE: &str = "git_stage";
pub const REMOTE_METHOD_GIT_UNSTAGE: &str = "git_unstage";
pub const REMOTE_METHOD_GIT_DISCARD: &str = "git_discard";
pub const REMOTE_METHOD_GIT_COMMIT: &str = "git_commit";
pub const REMOTE_METHOD_GIT_LOG: &str = "git_log";
pub const REMOTE_METHOD_GIT_SHOW_COMMIT: &str = "git_show_commit";
pub const REMOTE_METHOD_GIT_COMMIT_FILES: &str = "git_commit_files";
pub const REMOTE_METHOD_GIT_COMMIT_FILE_DIFF: &str = "git_commit_file_diff";
pub const REMOTE_METHOD_GIT_REMOTE_URL: &str = "git_remote_url";
pub const REMOTE_METHOD_GIT_FETCH: &str = "git_fetch";
pub const REMOTE_METHOD_GIT_PULL_FF_ONLY: &str = "git_pull_ff_only";
pub const REMOTE_METHOD_GIT_PUSH: &str = "git_push";
pub const REMOTE_METHOD_GIT_LIST_BRANCHES: &str = "git_list_branches";
pub const REMOTE_METHOD_GIT_CHECKOUT_BRANCH: &str = "git_checkout_branch";
pub const REMOTE_METHOD_SHELL_RUN: &str = "shell_run";
pub const REMOTE_METHOD_SHELL_SESSION_OPEN: &str = "shell_session_open";
pub const REMOTE_METHOD_SHELL_SESSION_RUN: &str = "shell_session_run";
pub const REMOTE_METHOD_SHELL_SESSION_CLOSE: &str = "shell_session_close";
pub const REMOTE_METHOD_SHELL_BG_SPAWN: &str = "shell_bg_spawn";
pub const REMOTE_METHOD_SHELL_BG_LOGS: &str = "shell_bg_logs";
pub const REMOTE_METHOD_SHELL_BG_KILL: &str = "shell_bg_kill";

// Docker capabilities / daemon: version, compose v2/v1, swarm state,
// server version, rootless/socket, context.
pub const REMOTE_METHOD_DOCKER_CAPABILITIES: &str = "docker_capabilities";
// Docker disk usage + stats/events via background procs.
pub const REMOTE_METHOD_DOCKER_SYSTEM_DF: &str = "docker_system_df";
pub const REMOTE_METHOD_DOCKER_STATS: &str = "docker_stats";
pub const REMOTE_METHOD_DOCKER_EVENTS_SPAWN: &str = "docker_events_spawn";
pub const REMOTE_METHOD_DOCKER_EVENTS_POLL: &str = "docker_events_poll";
pub const REMOTE_METHOD_DOCKER_EVENTS_KILL: &str = "docker_events_kill";
// Docker containers.
pub const REMOTE_METHOD_DOCKER_PS: &str = "docker_ps";
pub const REMOTE_METHOD_DOCKER_INSPECT: &str = "docker_inspect";
pub const REMOTE_METHOD_DOCKER_START: &str = "docker_start";
pub const REMOTE_METHOD_DOCKER_STOP: &str = "docker_stop";
pub const REMOTE_METHOD_DOCKER_RESTART: &str = "docker_restart";
pub const REMOTE_METHOD_DOCKER_KILL: &str = "docker_kill";
pub const REMOTE_METHOD_DOCKER_RM: &str = "docker_rm";
pub const REMOTE_METHOD_DOCKER_PRUNE: &str = "docker_prune";
pub const REMOTE_METHOD_DOCKER_CONTAINER_SHELL_PROBE: &str = "docker_container_shell_probe";
pub const REMOTE_METHOD_DOCKER_CP_TO: &str = "docker_cp_to";
pub const REMOTE_METHOD_DOCKER_CP_FROM: &str = "docker_cp_from";
// Docker images / registry.
pub const REMOTE_METHOD_DOCKER_IMAGES: &str = "docker_images";
pub const REMOTE_METHOD_DOCKER_PULL: &str = "docker_pull";
pub const REMOTE_METHOD_DOCKER_RMI: &str = "docker_rmi";
pub const REMOTE_METHOD_DOCKER_IMAGE_UPDATE_CHECK: &str = "docker_image_update_check";
pub const REMOTE_METHOD_DOCKER_IMAGE_TAG: &str = "docker_image_tag";
pub const REMOTE_METHOD_DOCKER_IMAGE_PUSH: &str = "docker_image_push";
pub const REMOTE_METHOD_DOCKER_IMAGE_HISTORY: &str = "docker_image_history";
pub const REMOTE_METHOD_DOCKER_IMAGE_DIFF: &str = "docker_image_diff";
pub const REMOTE_METHOD_DOCKER_BUILD: &str = "docker_build";
pub const REMOTE_METHOD_DOCKER_REGISTRY_LOGIN: &str = "docker_registry_login";
pub const REMOTE_METHOD_DOCKER_REGISTRY_LOGOUT: &str = "docker_registry_logout";
pub const REMOTE_METHOD_DOCKER_REGISTRY_LIST: &str = "docker_registry_list";
// Docker volumes / networks.
pub const REMOTE_METHOD_DOCKER_VOLUMES_LS: &str = "docker_volumes_ls";
pub const REMOTE_METHOD_DOCKER_VOLUME_RM: &str = "docker_volume_rm";
pub const REMOTE_METHOD_DOCKER_NETWORKS_LS: &str = "docker_networks_ls";
pub const REMOTE_METHOD_DOCKER_NETWORK_RM: &str = "docker_network_rm";
// Docker logs via background procs.
pub const REMOTE_METHOD_DOCKER_LOGS_SPAWN: &str = "docker_logs_spawn";
pub const REMOTE_METHOD_DOCKER_LOGS_POLL: &str = "docker_logs_poll";
pub const REMOTE_METHOD_DOCKER_LOGS_KILL: &str = "docker_logs_kill";
// Docker compose.
pub const REMOTE_METHOD_DOCKER_COMPOSE_DETECT: &str = "docker_compose_detect";
pub const REMOTE_METHOD_DOCKER_COMPOSE_PS: &str = "docker_compose_ps";
pub const REMOTE_METHOD_DOCKER_COMPOSE_CONFIG: &str = "docker_compose_config";
pub const REMOTE_METHOD_DOCKER_COMPOSE_UP: &str = "docker_compose_up";
pub const REMOTE_METHOD_DOCKER_COMPOSE_DOWN: &str = "docker_compose_down";
pub const REMOTE_METHOD_DOCKER_COMPOSE_RESTART: &str = "docker_compose_restart";
pub const REMOTE_METHOD_DOCKER_COMPOSE_PULL: &str = "docker_compose_pull";
pub const REMOTE_METHOD_DOCKER_COMPOSE_LOGS: &str = "docker_compose_logs";
pub const REMOTE_METHOD_DOCKER_COMPOSE_BUILD: &str = "docker_compose_build";
// Docker swarm / service / stack.
pub const REMOTE_METHOD_DOCKER_SWARM_INFO: &str = "docker_swarm_info";
pub const REMOTE_METHOD_DOCKER_NODE_LS: &str = "docker_node_ls";
pub const REMOTE_METHOD_DOCKER_NODE_UPDATE: &str = "docker_node_update";
pub const REMOTE_METHOD_DOCKER_NODE_PROMOTE: &str = "docker_node_promote";
pub const REMOTE_METHOD_DOCKER_NODE_DEMOTE: &str = "docker_node_demote";
pub const REMOTE_METHOD_DOCKER_SWARM_INIT: &str = "docker_swarm_init";
pub const REMOTE_METHOD_DOCKER_SWARM_JOIN: &str = "docker_swarm_join";
pub const REMOTE_METHOD_DOCKER_SWARM_LEAVE: &str = "docker_swarm_leave";
pub const REMOTE_METHOD_DOCKER_SERVICE_LS: &str = "docker_service_ls";
pub const REMOTE_METHOD_DOCKER_SERVICE_INSPECT: &str = "docker_service_inspect";
pub const REMOTE_METHOD_DOCKER_SERVICE_PS: &str = "docker_service_ps";
pub const REMOTE_METHOD_DOCKER_SERVICE_SCALE: &str = "docker_service_scale";
pub const REMOTE_METHOD_DOCKER_SERVICE_UPDATE: &str = "docker_service_update";
pub const REMOTE_METHOD_DOCKER_SERVICE_RM: &str = "docker_service_rm";
pub const REMOTE_METHOD_DOCKER_SERVICE_ROLLBACK: &str = "docker_service_rollback";
pub const REMOTE_METHOD_DOCKER_SERVICE_LOGS: &str = "docker_service_logs";
pub const REMOTE_METHOD_DOCKER_STACK_LS: &str = "docker_stack_ls";
pub const REMOTE_METHOD_DOCKER_STACK_SERVICES: &str = "docker_stack_services";
pub const REMOTE_METHOD_DOCKER_STACK_PS: &str = "docker_stack_ps";
pub const REMOTE_METHOD_DOCKER_STACK_DEPLOY: &str = "docker_stack_deploy";
pub const REMOTE_METHOD_DOCKER_STACK_RM: &str = "docker_stack_rm";
// Docker swarm secrets / configs.
pub const REMOTE_METHOD_DOCKER_SECRET_LS: &str = "docker_secret_ls";
pub const REMOTE_METHOD_DOCKER_SECRET_CREATE: &str = "docker_secret_create";
pub const REMOTE_METHOD_DOCKER_SECRET_RM: &str = "docker_secret_rm";
pub const REMOTE_METHOD_DOCKER_CONFIG_LS: &str = "docker_config_ls";
pub const REMOTE_METHOD_DOCKER_CONFIG_CREATE: &str = "docker_config_create";
pub const REMOTE_METHOD_DOCKER_CONFIG_RM: &str = "docker_config_rm";

pub const REMOTE_METHODS: &[&str] = &[
    METHOD_PING,
    METHOD_CAPABILITIES,
    REMOTE_METHOD_FS_READ_DIR,
    REMOTE_METHOD_FS_READ_FILE,
    REMOTE_METHOD_FS_READ_BYTES,
    REMOTE_METHOD_FS_WRITE_FILE,
    REMOTE_METHOD_FS_STAT,
    REMOTE_METHOD_FS_SEARCH,
    REMOTE_METHOD_FS_GREP,
    REMOTE_METHOD_FS_CREATE_FILE,
    REMOTE_METHOD_FS_CREATE_DIR,
    REMOTE_METHOD_FS_RENAME,
    REMOTE_METHOD_FS_DELETE,
    REMOTE_METHOD_FS_DELETE_BATCH,
    REMOTE_METHOD_FS_MOVE,
    REMOTE_METHOD_FS_COPY,
    REMOTE_METHOD_GIT_PANEL_SNAPSHOT,
    REMOTE_METHOD_GIT_STATUS,
    REMOTE_METHOD_GIT_RESOLVE_REPO,
    REMOTE_METHOD_GIT_DIFF,
    REMOTE_METHOD_GIT_DIFF_CONTENT,
    REMOTE_METHOD_GIT_STAGE,
    REMOTE_METHOD_GIT_UNSTAGE,
    REMOTE_METHOD_GIT_DISCARD,
    REMOTE_METHOD_GIT_COMMIT,
    REMOTE_METHOD_GIT_LOG,
    REMOTE_METHOD_GIT_SHOW_COMMIT,
    REMOTE_METHOD_GIT_COMMIT_FILES,
    REMOTE_METHOD_GIT_COMMIT_FILE_DIFF,
    REMOTE_METHOD_GIT_REMOTE_URL,
    REMOTE_METHOD_GIT_FETCH,
    REMOTE_METHOD_GIT_PULL_FF_ONLY,
    REMOTE_METHOD_GIT_PUSH,
    REMOTE_METHOD_GIT_LIST_BRANCHES,
    REMOTE_METHOD_GIT_CHECKOUT_BRANCH,
    REMOTE_METHOD_SHELL_RUN,
    REMOTE_METHOD_SHELL_SESSION_OPEN,
    REMOTE_METHOD_SHELL_SESSION_RUN,
    REMOTE_METHOD_SHELL_SESSION_CLOSE,
    REMOTE_METHOD_SHELL_BG_SPAWN,
    REMOTE_METHOD_SHELL_BG_LOGS,
    REMOTE_METHOD_SHELL_BG_KILL,
    REMOTE_METHOD_DOCKER_CAPABILITIES,
    REMOTE_METHOD_DOCKER_SYSTEM_DF,
    REMOTE_METHOD_DOCKER_STATS,
    REMOTE_METHOD_DOCKER_EVENTS_SPAWN,
    REMOTE_METHOD_DOCKER_EVENTS_POLL,
    REMOTE_METHOD_DOCKER_EVENTS_KILL,
    REMOTE_METHOD_DOCKER_PS,
    REMOTE_METHOD_DOCKER_INSPECT,
    REMOTE_METHOD_DOCKER_START,
    REMOTE_METHOD_DOCKER_STOP,
    REMOTE_METHOD_DOCKER_RESTART,
    REMOTE_METHOD_DOCKER_KILL,
    REMOTE_METHOD_DOCKER_RM,
    REMOTE_METHOD_DOCKER_PRUNE,
    REMOTE_METHOD_DOCKER_CONTAINER_SHELL_PROBE,
    REMOTE_METHOD_DOCKER_CP_TO,
    REMOTE_METHOD_DOCKER_CP_FROM,
    REMOTE_METHOD_DOCKER_IMAGES,
    REMOTE_METHOD_DOCKER_PULL,
    REMOTE_METHOD_DOCKER_RMI,
    REMOTE_METHOD_DOCKER_IMAGE_UPDATE_CHECK,
    REMOTE_METHOD_DOCKER_IMAGE_TAG,
    REMOTE_METHOD_DOCKER_IMAGE_PUSH,
    REMOTE_METHOD_DOCKER_IMAGE_HISTORY,
    REMOTE_METHOD_DOCKER_IMAGE_DIFF,
    REMOTE_METHOD_DOCKER_BUILD,
    REMOTE_METHOD_DOCKER_REGISTRY_LOGIN,
    REMOTE_METHOD_DOCKER_REGISTRY_LOGOUT,
    REMOTE_METHOD_DOCKER_REGISTRY_LIST,
    REMOTE_METHOD_DOCKER_VOLUMES_LS,
    REMOTE_METHOD_DOCKER_VOLUME_RM,
    REMOTE_METHOD_DOCKER_NETWORKS_LS,
    REMOTE_METHOD_DOCKER_NETWORK_RM,
    REMOTE_METHOD_DOCKER_LOGS_SPAWN,
    REMOTE_METHOD_DOCKER_LOGS_POLL,
    REMOTE_METHOD_DOCKER_LOGS_KILL,
    REMOTE_METHOD_DOCKER_COMPOSE_DETECT,
    REMOTE_METHOD_DOCKER_COMPOSE_PS,
    REMOTE_METHOD_DOCKER_COMPOSE_CONFIG,
    REMOTE_METHOD_DOCKER_COMPOSE_UP,
    REMOTE_METHOD_DOCKER_COMPOSE_DOWN,
    REMOTE_METHOD_DOCKER_COMPOSE_RESTART,
    REMOTE_METHOD_DOCKER_COMPOSE_PULL,
    REMOTE_METHOD_DOCKER_COMPOSE_LOGS,
    REMOTE_METHOD_DOCKER_COMPOSE_BUILD,
    REMOTE_METHOD_DOCKER_SWARM_INFO,
    REMOTE_METHOD_DOCKER_NODE_LS,
    REMOTE_METHOD_DOCKER_NODE_UPDATE,
    REMOTE_METHOD_DOCKER_NODE_PROMOTE,
    REMOTE_METHOD_DOCKER_NODE_DEMOTE,
    REMOTE_METHOD_DOCKER_SWARM_INIT,
    REMOTE_METHOD_DOCKER_SWARM_JOIN,
    REMOTE_METHOD_DOCKER_SWARM_LEAVE,
    REMOTE_METHOD_DOCKER_SERVICE_LS,
    REMOTE_METHOD_DOCKER_SERVICE_INSPECT,
    REMOTE_METHOD_DOCKER_SERVICE_PS,
    REMOTE_METHOD_DOCKER_SERVICE_SCALE,
    REMOTE_METHOD_DOCKER_SERVICE_UPDATE,
    REMOTE_METHOD_DOCKER_SERVICE_RM,
    REMOTE_METHOD_DOCKER_SERVICE_ROLLBACK,
    REMOTE_METHOD_DOCKER_SERVICE_LOGS,
    REMOTE_METHOD_DOCKER_STACK_LS,
    REMOTE_METHOD_DOCKER_STACK_SERVICES,
    REMOTE_METHOD_DOCKER_STACK_PS,
    REMOTE_METHOD_DOCKER_STACK_DEPLOY,
    REMOTE_METHOD_DOCKER_STACK_RM,
    REMOTE_METHOD_DOCKER_SECRET_LS,
    REMOTE_METHOD_DOCKER_SECRET_CREATE,
    REMOTE_METHOD_DOCKER_SECRET_RM,
    REMOTE_METHOD_DOCKER_CONFIG_LS,
    REMOTE_METHOD_DOCKER_CONFIG_CREATE,
    REMOTE_METHOD_DOCKER_CONFIG_RM,
];

#[cfg(test)]
mod docker_registry_tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn docker_method_names_are_unique() {
        let docker: Vec<&str> = REMOTE_METHODS
            .iter()
            .copied()
            .filter(|m| m.starts_with("docker_"))
            .collect();
        assert!(!docker.is_empty(), "expected docker methods in registry");
        let set: HashSet<&str> = docker.iter().copied().collect();
        assert_eq!(set.len(), docker.len(), "duplicate docker method name");
    }

    #[test]
    fn registry_contains_all_docker_consts() {
        let expected = [
            REMOTE_METHOD_DOCKER_CAPABILITIES,
            REMOTE_METHOD_DOCKER_SYSTEM_DF,
            REMOTE_METHOD_DOCKER_STATS,
            REMOTE_METHOD_DOCKER_EVENTS_SPAWN,
            REMOTE_METHOD_DOCKER_EVENTS_POLL,
            REMOTE_METHOD_DOCKER_EVENTS_KILL,
            REMOTE_METHOD_DOCKER_PS,
            REMOTE_METHOD_DOCKER_INSPECT,
            REMOTE_METHOD_DOCKER_START,
            REMOTE_METHOD_DOCKER_STOP,
            REMOTE_METHOD_DOCKER_RESTART,
            REMOTE_METHOD_DOCKER_KILL,
            REMOTE_METHOD_DOCKER_RM,
            REMOTE_METHOD_DOCKER_PRUNE,
            REMOTE_METHOD_DOCKER_CONTAINER_SHELL_PROBE,
            REMOTE_METHOD_DOCKER_CP_TO,
            REMOTE_METHOD_DOCKER_CP_FROM,
            REMOTE_METHOD_DOCKER_IMAGES,
            REMOTE_METHOD_DOCKER_PULL,
            REMOTE_METHOD_DOCKER_RMI,
            REMOTE_METHOD_DOCKER_IMAGE_UPDATE_CHECK,
            REMOTE_METHOD_DOCKER_IMAGE_TAG,
            REMOTE_METHOD_DOCKER_IMAGE_PUSH,
            REMOTE_METHOD_DOCKER_IMAGE_HISTORY,
            REMOTE_METHOD_DOCKER_IMAGE_DIFF,
            REMOTE_METHOD_DOCKER_BUILD,
            REMOTE_METHOD_DOCKER_REGISTRY_LOGIN,
            REMOTE_METHOD_DOCKER_REGISTRY_LOGOUT,
            REMOTE_METHOD_DOCKER_REGISTRY_LIST,
            REMOTE_METHOD_DOCKER_VOLUMES_LS,
            REMOTE_METHOD_DOCKER_VOLUME_RM,
            REMOTE_METHOD_DOCKER_NETWORKS_LS,
            REMOTE_METHOD_DOCKER_NETWORK_RM,
            REMOTE_METHOD_DOCKER_LOGS_SPAWN,
            REMOTE_METHOD_DOCKER_LOGS_POLL,
            REMOTE_METHOD_DOCKER_LOGS_KILL,
            REMOTE_METHOD_DOCKER_COMPOSE_DETECT,
            REMOTE_METHOD_DOCKER_COMPOSE_PS,
            REMOTE_METHOD_DOCKER_COMPOSE_CONFIG,
            REMOTE_METHOD_DOCKER_COMPOSE_UP,
            REMOTE_METHOD_DOCKER_COMPOSE_DOWN,
            REMOTE_METHOD_DOCKER_COMPOSE_RESTART,
            REMOTE_METHOD_DOCKER_COMPOSE_PULL,
            REMOTE_METHOD_DOCKER_COMPOSE_LOGS,
            REMOTE_METHOD_DOCKER_COMPOSE_BUILD,
            REMOTE_METHOD_DOCKER_SWARM_INFO,
            REMOTE_METHOD_DOCKER_NODE_LS,
            REMOTE_METHOD_DOCKER_NODE_UPDATE,
            REMOTE_METHOD_DOCKER_NODE_PROMOTE,
            REMOTE_METHOD_DOCKER_NODE_DEMOTE,
            REMOTE_METHOD_DOCKER_SWARM_INIT,
            REMOTE_METHOD_DOCKER_SWARM_JOIN,
            REMOTE_METHOD_DOCKER_SWARM_LEAVE,
            REMOTE_METHOD_DOCKER_SERVICE_LS,
            REMOTE_METHOD_DOCKER_SERVICE_INSPECT,
            REMOTE_METHOD_DOCKER_SERVICE_PS,
            REMOTE_METHOD_DOCKER_SERVICE_SCALE,
            REMOTE_METHOD_DOCKER_SERVICE_UPDATE,
            REMOTE_METHOD_DOCKER_SERVICE_RM,
            REMOTE_METHOD_DOCKER_SERVICE_ROLLBACK,
            REMOTE_METHOD_DOCKER_SERVICE_LOGS,
            REMOTE_METHOD_DOCKER_STACK_LS,
            REMOTE_METHOD_DOCKER_STACK_SERVICES,
            REMOTE_METHOD_DOCKER_STACK_PS,
            REMOTE_METHOD_DOCKER_STACK_DEPLOY,
            REMOTE_METHOD_DOCKER_STACK_RM,
            REMOTE_METHOD_DOCKER_SECRET_LS,
            REMOTE_METHOD_DOCKER_SECRET_CREATE,
            REMOTE_METHOD_DOCKER_SECRET_RM,
            REMOTE_METHOD_DOCKER_CONFIG_LS,
            REMOTE_METHOD_DOCKER_CONFIG_CREATE,
            REMOTE_METHOD_DOCKER_CONFIG_RM,
        ];
        for name in expected {
            assert!(
                REMOTE_METHODS.contains(&name),
                "registry missing docker method {name}"
            );
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct CallerContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<u32>,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub struct ControlRequest {
    pub protocol: u16,
    pub id: String,
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub caller: CallerContext,
    /// v3 lane affinity: background-handle namespace for this request.
    /// Absent = default lane 0. Agents that predate v3 ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<u8>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ControlError {
    pub code: String,
    pub message: String,
}

impl ControlError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ControlResponse {
    pub protocol: u16,
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

impl ControlResponse {
    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            id: id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(
        id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            id: id.into(),
            ok: false,
            result: None,
            error: Some(ControlError::new(code, message)),
        }
    }
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub struct ControlDescriptor {
    pub protocol: u16,
    pub address: String,
    pub token: String,
    pub pid: u32,
    pub app_version: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct FrontendRequest {
    pub id: String,
    pub method: String,
    pub params: Value,
    pub caller: CallerContext,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct FrontendResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct OpenParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(default = "default_focus")]
    pub focus: bool,
}

fn default_focus() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_round_trips_without_caller_context() {
        let raw = json!({
            "protocol": PROTOCOL_VERSION,
            "id": "42",
            "token": "secret",
            "method": METHOD_PING,
            "params": {}
        });
        let request: ControlRequest = serde_json::from_value(raw).expect("deserialize request");
        assert_eq!(request.caller, CallerContext::default());
        assert_eq!(request.method, METHOD_PING);
    }

    #[test]
    fn response_shapes_are_unambiguous() {
        let success = ControlResponse::success("1", json!({ "pong": true }));
        assert!(success.ok);
        assert!(success.result.is_some());
        assert!(success.error.is_none());

        let failure = ControlResponse::failure("2", "invalid_request", "bad request");
        assert!(!failure.ok);
        assert!(failure.result.is_none());
        assert_eq!(failure.error.expect("error").code, "invalid_request");
    }

    #[test]
    fn open_defaults_to_focusing_the_target() {
        let params: OpenParams =
            serde_json::from_value(json!({ "path": "/tmp/a" })).expect("deserialize open params");
        assert!(params.focus);
    }
}
