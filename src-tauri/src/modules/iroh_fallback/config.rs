//! Non-secret iroh transport configuration (custom relay URLs).
//!
//! The n0 Iroh Services API key is a secret and lives in the OS keychain
//! (`secrets_*`, service `terax-iroh`), never in this file - `IrohConfig`'s
//! `api_secret` field is `#[serde(skip)]` precisely so it cannot be
//! serialized here even by accident. This file only holds relay URLs, which
//! are public addresses.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IrohConfig {
    /// Custom relay URLs. Empty means "use the default for the selected
    /// mode": n0 production relays for both the public and services presets.
    /// Non-empty with no API key means a fully self-hosted, n0-independent
    /// deployment (the desktop then dials these addresses explicitly and the
    /// agent disables n0 DNS address lookup).
    #[serde(default)]
    pub relay_urls: Vec<String>,
    /// In-memory only. Loaded from / written to the keychain by the
    /// commands; never serialized (see module docs).
    #[serde(skip)]
    pub api_secret: Option<String>,
}

impl IrohConfig {
    /// True when neither an API key nor custom relays are configured, i.e.
    /// the zero-config default (n0 public relays + n0 DNS lookup).
    pub fn is_default(&self) -> bool {
        self.api_secret.as_deref().unwrap_or("").is_empty() && self.relay_urls.is_empty()
    }
}

/// Reads the config from `path`. A missing or malformed file is the default,
/// matching the zero-config case (never an error the user has to resolve to
/// get a working app).
pub fn load(path: &Path) -> IrohConfig {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<IrohConfig>(&b).ok())
        .unwrap_or_default()
}

/// Writes the config atomically, `0600` on unix. The API key is excluded by
/// the `#[serde(skip)]` on `IrohConfig::api_secret`.
pub fn save(path: &Path, cfg: &IrohConfig) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// `<app_local_data_dir>/terax-iroh.json`, mirroring the host-store layout.
pub fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("terax-iroh.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_relay_urls() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terax-iroh.json");
        let cfg = IrohConfig {
            relay_urls: vec!["https://relay.example.com".into()],
            api_secret: Some("super-secret".into()),
        };
        save(&path, &cfg).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.relay_urls, cfg.relay_urls);
        assert_eq!(loaded.api_secret, None, "api secret must never be persisted");
    }

    #[test]
    fn missing_file_is_default() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = load(&dir.path().join("nope.json"));
        assert!(loaded.is_default());
    }

    #[test]
    fn malformed_file_is_default_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terax-iroh.json");
        std::fs::write(&path, b"not json").unwrap();
        assert!(load(&path).is_default());
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terax-iroh.json");
        save(&path, &IrohConfig::default()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
