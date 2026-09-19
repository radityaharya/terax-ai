pub use terax_core::fs::{DirEntry, EntryKind};

use crate::modules::workspace::{require_local_workspace, resolve_path, WorkspaceEnv};

/// Lists immediate children of `path`. Dirs first, then files, each sorted
/// with `natural_cmp` (numeric-aware, case-insensitive). Dot-prefixed entries
/// (files and dirs) are hidden unless `show_hidden` is set. `git_decorations`
/// opts into the per-entry `gitignored` flag; off by default so non-explorer
/// callers pay nothing.
#[tauri::command]
pub fn fs_read_dir(
    path: String,
    show_hidden: bool,
    git_decorations: Option<bool>,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<DirEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let root = resolve_path(&path, &workspace);
    terax_core::fs::read_dir_entries(&root, show_hidden, git_decorations.unwrap_or(false))
}

/// Lists immediate subdirectories of `path`. Kept for the CwdBreadcrumb.
///
/// Symlinks to directories are included (matches shell `cd` semantics).
/// Hidden entries are filtered by dot-prefix only.
#[tauri::command]
pub fn list_subdirs(
    path: String,
    show_hidden: bool,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let root = resolve_path(&path, &workspace);
    terax_core::fs::list_subdir_names(&root, show_hidden)
}
