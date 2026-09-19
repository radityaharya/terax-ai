use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::config::ImportedHost;
use crate::modules::workspace::is_safe_ssh_host_id;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    pub id: String,
    pub alias: String,
    pub user: String,
    pub hostname: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_space_id: Option<String>,
    #[serde(default)]
    pub agent_forward: bool,
    #[serde(default)]
    pub created_at_ms: u64,
    #[serde(default)]
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostInput {
    pub id: Option<String>,
    pub alias: String,
    pub user: String,
    pub hostname: String,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub remote_root: Option<String>,
    pub agent_forward: Option<bool>,
}

pub fn normalize_host_input(input: &SshHostInput) -> Result<SshHostFields, String> {
    let alias = input.alias.trim().to_string();
    if alias.is_empty() || alias.len() > 128 {
        return Err("host alias must be 1-128 characters".into());
    }
    let user = input.user.trim().to_string();
    if user.is_empty() || user.len() > 128 {
        return Err("user must be 1-128 characters".into());
    }
    if user.contains([' ', '\t', '\n', '\r', '@', ':']) {
        return Err("user contains invalid characters".into());
    }
    let hostname = input.hostname.trim().to_string();
    if hostname.is_empty() || hostname.len() > 253 {
        return Err("hostname must be 1-253 characters".into());
    }
    if hostname.contains([' ', '\t', '\n', '\r']) {
        return Err("hostname contains invalid characters".into());
    }
    let port = input.port.unwrap_or(22);
    if port == 0 {
        return Err("port must be 1-65535".into());
    }
    let identity_file = input
        .identity_file
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(ref path) = identity_file {
        if path.len() > 1024 || path.contains('\0') {
            return Err("identity file path is invalid".into());
        }
    }
    let remote_root = input
        .remote_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(ref root) = remote_root {
        if !root.starts_with('/') || root.len() > 1024 || root.contains('\0') {
            return Err("remote root must be an absolute path".into());
        }
    }
    Ok(SshHostFields {
        alias,
        user,
        hostname,
        port,
        identity_file,
        remote_root,
        agent_forward: input.agent_forward.unwrap_or(false),
    })
}

pub struct SshHostFields {
    pub alias: String,
    pub user: String,
    pub hostname: String,
    pub port: u16,
    pub identity_file: Option<String>,
    pub remote_root: Option<String>,
    pub agent_forward: bool,
}

pub fn host_id_for(alias: &str) -> String {
    let mut id: String = alias
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else if matches!(c, '.' | '_' | '-' | ' ') {
                c
            } else {
                '-'
            }
        })
        .collect();
    while id.contains("..") {
        id = id.replace("..", "-");
    }
    id.trim_matches(|c| c == '.' || c == '-' || c == '_')
        .to_string()
}

pub fn imported_to_fields(imported: &ImportedHost, default_user: &str) -> SshHostFields {
    SshHostFields {
        alias: imported.alias.clone(),
        user: imported
            .user
            .clone()
            .unwrap_or_else(|| default_user.to_string()),
        hostname: imported
            .hostname
            .clone()
            .unwrap_or_else(|| imported.alias.clone()),
        port: imported.port.unwrap_or(22),
        identity_file: imported.identity_file.clone(),
        remote_root: None,
        agent_forward: false,
    }
}

pub struct HostStore {
    hosts: Mutex<HashMap<String, SshHost>>,
}

impl Default for HostStore {
    fn default() -> Self {
        Self {
            hosts: Mutex::new(HashMap::new()),
        }
    }
}

static HOST_CACHE: OnceLock<HostStore> = OnceLock::new();

pub fn host_store() -> &'static HostStore {
    HOST_CACHE.get_or_init(HostStore::default)
}

impl HostStore {
    pub fn list(&self) -> Vec<SshHost> {
        let mut hosts: Vec<SshHost> = self.hosts.lock().unwrap().values().cloned().collect();
        hosts.sort_by(|a, b| a.alias.to_lowercase().cmp(&b.alias.to_lowercase()));
        hosts
    }

    pub fn get(&self, id: &str) -> Option<SshHost> {
        self.hosts.lock().unwrap().get(id).cloned()
    }

    pub fn upsert(&self, host: SshHost) {
        self.hosts.lock().unwrap().insert(host.id.clone(), host);
    }

    pub fn remove(&self, id: &str) -> bool {
        self.hosts.lock().unwrap().remove(id).is_some()
    }

    pub fn save_all(&self, hosts: Vec<SshHost>) {
        let mut map = self.hosts.lock().unwrap();
        map.clear();
        for host in hosts {
            map.insert(host.id.clone(), host);
        }
    }
}

pub fn validate_host_id(id: &str) -> Result<(), String> {
    if is_safe_ssh_host_id(id) {
        Ok(())
    } else {
        Err(format!("unsafe SSH host id: {id}"))
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(alias: &str) -> SshHostInput {
        SshHostInput {
            id: None,
            alias: alias.into(),
            user: "deploy".into(),
            hostname: "10.0.0.5".into(),
            port: Some(22),
            identity_file: None,
            remote_root: None,
            agent_forward: None,
        }
    }

    #[test]
    fn rejects_empty_alias_and_bad_user() {
        assert!(normalize_host_input(&input("")).is_err());
        let mut bad = input("ok");
        bad.user = "a b".into();
        assert!(normalize_host_input(&bad).is_err());
    }

    #[test]
    fn rejects_relative_remote_root() {
        let mut bad = input("ok");
        bad.remote_root = Some("relative/path".into());
        assert!(normalize_host_input(&bad).is_err());
    }

    #[test]
    fn host_id_slug_is_filesafe() {
        assert_eq!(host_id_for("Prod Web 01!"), "prod web 01");
        assert_eq!(host_id_for("..evil.."), "evil");
        assert!(is_safe_ssh_host_id(&host_id_for("db.primary")));
    }

    #[test]
    fn store_round_trips_sorted() {
        let store = HostStore::default();
        for alias in ["zeta", "alpha"] {
            let fields = normalize_host_input(&input(alias)).unwrap();
            store.upsert(SshHost {
                id: host_id_for(alias),
                alias: fields.alias,
                user: fields.user,
                hostname: fields.hostname,
                port: fields.port,
                identity_file: None,
                remote_root: None,
                bound_space_id: None,
                agent_forward: false,
                created_at_ms: 0,
                updated_at_ms: 0,
            });
        }
        let listed = store.list();
        assert_eq!(listed[0].alias, "alpha");
        assert!(store.remove("alpha"));
        assert!(store.get("alpha").is_none());
    }
}
