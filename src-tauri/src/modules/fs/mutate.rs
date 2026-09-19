use crate::modules::workspace::{
    require_local_workspace, resolve_path, WorkspaceEnv, WorkspaceRegistry,
};

pub use terax_core::fs::mutate::{FsDeleteBatchResult, FsMoveResult};

fn resolve_authorized_root(
    root: &str,
    workspace: &WorkspaceEnv,
    registry: &WorkspaceRegistry,
) -> Result<std::path::PathBuf, String> {
    let resolved = resolve_path(root, workspace);
    // The desktop registry and the core registry share layout; the core
    // canonicalizer only needs the cache + roots, reached through a narrow
    // adapter below. For now resolve authorization stays desktop-side.
    let canonical = registry
        .canonicalize_cached(&resolved)
        .map_err(|error| format!("workspace root is not accessible: {error}"))?;
    if registry.is_authorized(&canonical) {
        Ok(canonical)
    } else {
        Err(format!(
            "workspace root is not authorized: {}",
            canonical.display()
        ))
    }
}

/// Creates a new empty file. Fails if the file already exists.
#[tauri::command]
pub fn fs_create_file(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let p = resolve_path(&path, &workspace);
    terax_core::fs::mutate::create_file(&p)
}

/// Creates a new directory. Fails if the directory already exists.
/// Parents are created as needed — matches the common "new folder" UX
/// where typing "a/b/c" creates the full chain.
#[tauri::command]
pub fn fs_create_dir(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let p = resolve_path(&path, &workspace);
    terax_core::fs::mutate::create_dir(&p)
}

/// Renames (or moves) a path. Refuses to overwrite an existing target.
#[tauri::command]
pub fn fs_rename(from: String, to: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let from_p = resolve_path(&from, &workspace);
    let to_p = resolve_path(&to, &workspace);
    terax_core::fs::mutate::rename_path(&from_p, &to_p)
}

/// Moves a path without clobbering unless replacement was explicitly approved.
#[tauri::command]
pub fn fs_move(
    from: String,
    to: String,
    root: String,
    expected_conflict: Option<String>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<FsMoveResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let root = resolve_authorized_root(&root, &workspace, &registry)?;
    let from_p = resolve_path(&from, &workspace);
    let to_p = resolve_path(&to, &workspace);
    terax_core::fs::mutate::move_paths(&from_p, &to_p, &root, expected_conflict.as_deref())
}

/// Deletes a file or directory (recursively for dirs). Callers are
/// responsible for confirming destructive operations with the user.
#[tauri::command]
pub fn fs_delete(path: String, workspace: Option<WorkspaceEnv>) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let p = resolve_path(&path, &workspace);
    terax_core::fs::mutate::delete_path(&p)
}

#[tauri::command]
pub fn fs_delete_batch(
    paths: Vec<String>,
    root: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> FsDeleteBatchResult {
    let workspace = WorkspaceEnv::from_option(workspace);
    if require_local_workspace(&workspace).is_err() {
        return FsDeleteBatchResult {
            deleted: Vec::new(),
            failed: paths.len(),
        };
    }
    let Ok(root) = resolve_authorized_root(&root, &workspace, &registry) else {
        return FsDeleteBatchResult {
            deleted: Vec::new(),
            failed: paths.len(),
        };
    };
    let resolved: Vec<(String, std::path::PathBuf)> = paths
        .into_iter()
        .map(|p| {
            let r = resolve_path(&p, &workspace);
            (p, r)
        })
        .collect();
    terax_core::fs::mutate::delete_batch(resolved, &root)
}

/// Copies external files/dirs into a destination directory, recursively for
/// dirs. Sources are absolute OS paths (from a drag-drop); only the destination
/// is workspace-resolved. Refuses to overwrite existing entries.
#[tauri::command]
pub fn fs_copy(
    sources: Vec<String>,
    dest_dir: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let dest = resolve_path(&dest_dir, &workspace);
    terax_core::fs::mutate::copy_into(&sources, &dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_workspace_is_rejected_before_mutation() {
        let ssh = Some(WorkspaceEnv::Ssh { host_id: "h".into() });
        assert!(fs_create_file("/x".into(), ssh.clone()).is_err());
        assert!(fs_create_dir("/x".into(), ssh.clone()).is_err());
        assert!(fs_rename("/a".into(), "/b".into(), ssh.clone()).is_err());
        assert!(fs_delete("/x".into(), ssh.clone()).is_err());
        assert!(fs_copy(vec!["/a".into()], "/d".into(), ssh.clone()).is_err());
    }
}
