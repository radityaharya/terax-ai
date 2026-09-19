use tauri::Emitter;

pub use terax_core::fs::file::{FileStat, ReadResult, StatKind};

use crate::modules::workspace::{require_local_workspace, resolve_path, WorkspaceEnv};

#[tauri::command]
pub async fn fs_read_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    force: Option<bool>,
) -> Result<ReadResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    terax_core::fs::file::read_file_sync(
        &resolve_path(&path, &workspace),
        force.unwrap_or(false),
    )
}

#[derive(serde::Serialize, Clone)]
struct FileWrittenEvent {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// Returns the new mtime so the editor can track disk state for conflict
/// detection without a follow-up stat.
#[tauri::command]
pub async fn fs_write_file(
    path: String,
    content: String,
    workspace: Option<WorkspaceEnv>,
    source: Option<String>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let target = resolve_path(&path, &workspace);
    let mtime = terax_core::fs::file::write_file_sync(&target, content.as_bytes())?;
    let _ = app.emit(
        "fs:file-written",
        FileWrittenEvent {
            path: path.clone(),
            source,
        },
    );

    Ok(mtime)
}

#[tauri::command]
pub async fn fs_canonicalize(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let p = resolve_path(&path, &workspace);
    terax_core::fs::file::canonicalize_sync(&p)
}

#[tauri::command]
pub async fn fs_stat(path: String, workspace: Option<WorkspaceEnv>) -> Result<FileStat, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let p = resolve_path(&path, &workspace);
    terax_core::fs::file::stat_sync(&p)
}

#[cfg(test)]
mod tests {
    // Logic lives in terax-core::fs::file; the Tauri wrappers only resolve
    // workspace paths and enforce the local-workspace guard.
    #[test]
    fn ssh_workspace_is_rejected_before_fs_access() {
        use crate::modules::workspace::WorkspaceEnv;
        let ssh = WorkspaceEnv::Ssh {
            host_id: "test".into(),
        };
        assert!(crate::modules::workspace::require_local_workspace(&ssh).is_err());
    }
}
