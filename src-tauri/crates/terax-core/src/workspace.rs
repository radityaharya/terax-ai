use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

// Short TTL keeps the auth-check TOCTOU window tight while still coalescing the
// burst of canonicalize calls within a single panel refresh (~100ms).
const CANONICAL_TTL: Duration = Duration::from_secs(1);
const CANONICAL_CACHE_CAP: usize = 256;

struct CanonicalEntry {
    canonical: PathBuf,
    inserted_at: Instant,
}

#[derive(Default)]
pub struct WorkspaceRegistry {
    roots: Mutex<HashSet<PathBuf>>,
    canonical_cache: Mutex<HashMap<PathBuf, CanonicalEntry>>,
}

impl WorkspaceRegistry {
    pub fn authorize<P: AsRef<Path>>(&self, path: P) -> std::io::Result<PathBuf> {
        let canonical = std::fs::canonicalize(path.as_ref())?;
        let mut set = self.roots.lock().expect("workspace registry poisoned");
        set.insert(canonical.clone());
        Ok(canonical)
    }

    pub fn is_authorized(&self, target: &Path) -> bool {
        let set = self.roots.lock().expect("workspace registry poisoned");
        set.iter().any(|root| target.starts_with(root))
    }

    pub fn canonicalize_cached<P: AsRef<Path>>(&self, path: P) -> std::io::Result<PathBuf> {
        let key = path.as_ref().to_path_buf();
        {
            let cache = self
                .canonical_cache
                .lock()
                .expect("canonical cache poisoned");
            if let Some(entry) = cache.get(&key) {
                if entry.inserted_at.elapsed() < CANONICAL_TTL {
                    return Ok(entry.canonical.clone());
                }
            }
        }
        let canonical = std::fs::canonicalize(&key)?;
        let mut cache = self
            .canonical_cache
            .lock()
            .expect("canonical cache poisoned");
        if cache.len() >= CANONICAL_CACHE_CAP {
            cache.retain(|_, entry| entry.inserted_at.elapsed() < CANONICAL_TTL);
            if cache.len() >= CANONICAL_CACHE_CAP {
                cache.clear();
            }
        }
        cache.insert(
            key,
            CanonicalEntry {
                canonical: canonical.clone(),
                inserted_at: Instant::now(),
            },
        );
        Ok(canonical)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkspaceEnv {
    #[default]
    Local,
    Wsl {
        distro: String,
    },
    Ssh {
        #[serde(rename = "hostId")]
        host_id: String,
    },
}

impl WorkspaceEnv {
    pub fn is_wsl(&self) -> bool {
        matches!(self, Self::Wsl { .. })
    }

    pub fn is_ssh(&self) -> bool {
        matches!(self, Self::Ssh { .. })
    }
}

/// True for SSH host ids safe to use in socket paths and scope keys.
/// Same shape as WSL distro names: alphanumeric with `.`, `_`, `-`, space
/// separators. Rejects anything that could traverse (`..`, `\`, `/`) so a
/// malicious host id cannot escape the master's socket dir.
pub fn is_safe_ssh_host_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 255 {
        return false;
    }
    if id == "." || id == ".." || id.starts_with('.') {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
        && !id.contains("..")
}

pub fn validate_ssh_host_id(id: &str) -> Result<(), String> {
    if is_safe_ssh_host_id(id) {
        Ok(())
    } else {
        Err(format!("unsafe SSH host id: {id}"))
    }
}

/// Resolve a path against a workspace. On the desktop this maps WSL paths
/// through the UNC share; on the remote agent every workspace is local to
/// the remote, so paths pass through unchanged. SSH variants must never
/// reach here on the desktop (guarded by require_local_workspace).
pub fn resolve_path(path: &str, _workspace: &WorkspaceEnv) -> PathBuf {
    PathBuf::from(path)
}

// `None` means "use bootstrapped default". `Some` is canonicalized to defeat
// symlink/`..` traversal and must sit under an authorized root.
pub fn authorize_spawn_cwd(
    registry: &WorkspaceRegistry,
    cwd: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<Option<PathBuf>, String> {
    let _ = workspace;
    let Some(cwd) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let resolved = resolve_path(cwd, workspace);
    let canonical =
        std::fs::canonicalize(&resolved).map_err(|e| format!("cwd not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("cwd is not a directory: {}", canonical.display()));
    }
    if !registry.is_authorized(&canonical) {
        return Err(format!(
            "cwd is outside the authorized workspace: {}",
            canonical.display()
        ));
    }
    Ok(Some(canonical))
}

// User-initiated terminal spawn: canonicalize, require a real dir, and register
// it as a root instead of rejecting paths outside existing roots.
pub fn authorize_user_spawn_cwd(
    registry: &WorkspaceRegistry,
    cwd: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<Option<PathBuf>, String> {
    let _ = workspace;
    let Some(cwd) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let resolved = resolve_path(cwd, workspace);
    let canonical =
        std::fs::canonicalize(&resolved).map_err(|e| format!("cwd not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("cwd is not a directory: {}", canonical.display()));
    }
    registry.authorize(&canonical).map_err(|e| e.to_string())?;
    Ok(Some(canonical))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_host_id_validator_accepts_real_ids() {
        assert!(is_safe_ssh_host_id("prod-web-01"));
        assert!(is_safe_ssh_host_id("db.primary"));
        assert!(validate_ssh_host_id("ok").is_ok());
    }

    #[test]
    fn ssh_host_id_validator_rejects_traversal() {
        assert!(!is_safe_ssh_host_id("../x"));
        assert!(validate_ssh_host_id("../x").is_err());
    }
}
