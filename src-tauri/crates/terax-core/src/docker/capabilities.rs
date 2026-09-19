use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What the Docker probe learned about a host. Drives the panel's daemon
/// pill, compose/stack availability, and empty states.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerCapabilities {
    pub installed: bool,
    #[serde(default)]
    pub client_version: String,
    #[serde(default)]
    pub server_version: String,
    #[serde(default)]
    pub daemon_running: bool,
    #[serde(default)]
    pub permission_denied: bool,
    /// docker compose v2 (`docker compose version`) available.
    #[serde(default)]
    pub compose_v2: bool,
    /// legacy `docker-compose` binary available.
    #[serde(default)]
    pub compose_v1: bool,
    /// swarm LocalNodeState ("active", "inactive", ...).
    #[serde(default)]
    pub swarm_state: String,
    #[serde(default)]
    pub rootless: bool,
    #[serde(default)]
    pub context: String,
}

/// Parse `docker version --format json` (`{"Client":{...},"Server":{...}}`)
/// plus the already-known compose/swarm/rootless probe results.
pub fn probe_capabilities(
    version_json: &str,
    compose_v2_ok: bool,
    compose_v1_ok: bool,
    swarm_state: &str,
    rootless: bool,
    context: &str,
    permission_denied: bool,
) -> DockerCapabilities {
    let v: Value = serde_json::from_str(version_json).unwrap_or(Value::Null);
    let client_version = v
        .get("Client")
        .and_then(|c| c.get("Version"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let server_version = v
        .get("Server")
        .and_then(|s| s.get("Version"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    DockerCapabilities {
        installed: true,
        client_version,
        server_version: server_version.clone(),
        daemon_running: !server_version.is_empty(),
        permission_denied,
        compose_v2: compose_v2_ok,
        compose_v1: compose_v1_ok,
        swarm_state: swarm_state.to_string(),
        rootless,
        context: context.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_healthy_daemon() {
        let v = r#"{"Client":{"Version":"27.1.0"},"Server":{"Version":"27.1.0"}}"#;
        let c = probe_capabilities(v, true, false, "inactive", false, "default", false);
        assert!(c.installed && c.daemon_running);
        assert_eq!(c.client_version, "27.1.0");
        assert!(c.compose_v2 && !c.compose_v1);
        assert_eq!(c.swarm_state, "inactive");
    }

    #[test]
    fn daemon_down_has_no_server_version() {
        let v = r#"{"Client":{"Version":"27.1.0"}}"#;
        let c = probe_capabilities(v, false, false, "", false, "", false);
        assert!(c.installed && !c.daemon_running);
    }

    #[test]
    fn garbage_version_json_is_installed_but_unknown() {
        let c = probe_capabilities("nope", false, false, "", false, "", true);
        assert!(c.installed && !c.daemon_running && c.permission_denied);
    }
}
