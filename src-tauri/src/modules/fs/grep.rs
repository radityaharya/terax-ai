use std::sync::atomic::Ordering;

pub use terax_core::fs::grep::{
    escape_literal, GlobHit, GlobResponse, GrepHit, GrepResponse, DEFAULT_MAX_RESULTS,
};

use crate::modules::workspace::{require_local_workspace, resolve_path, WorkspaceEnv};

/// Supersession counter for interactive content search. Each new interactive
/// query bumps the generation; in-flight walks observe the change and quit,
/// so fast typing stops superseded searches server-side instead of letting
/// them run to completion.
#[derive(Default)]
pub struct ContentSearchState {
    generation: std::sync::atomic::AtomicU64,
}

#[tauri::command]
pub fn fs_grep(
    pattern: String,
    root: String,
    glob: Option<Vec<String>>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GrepResponse, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let root_path = resolve_path(&root, &workspace);
    terax_core::fs::grep::grep_files(
        &root_path,
        &root,
        workspace.is_wsl(),
        &pattern,
        glob.as_deref().unwrap_or(&[]),
        case_insensitive.unwrap_or(false),
        max_results.unwrap_or(DEFAULT_MAX_RESULTS),
        &|| false,
    )
}

/// Interactive content search for the command palette. Treats the query as a
/// literal (smart-case), and self-cancels when a newer query arrives.
#[tauri::command]
pub fn fs_grep_interactive(
    state: tauri::State<'_, ContentSearchState>,
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GrepResponse, String> {
    let my_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let root_path = resolve_path(&root, &workspace);
    let cancel = || state.generation.load(Ordering::SeqCst) != my_gen;
    terax_core::fs::grep::grep_interactive(
        &root_path,
        &root,
        workspace.is_wsl(),
        &pattern,
        max_results.unwrap_or(DEFAULT_MAX_RESULTS),
        &cancel,
    )
}

#[tauri::command]
pub fn fs_glob(
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GlobResponse, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let root_path = resolve_path(&root, &workspace);
    terax_core::fs::grep::glob_files(
        &root_path,
        &root,
        workspace.is_wsl(),
        &pattern,
        max_results.unwrap_or(500),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ssh_before_grep() {
        let ssh = WorkspaceEnv::Ssh {
            host_id: "h".into(),
        };
        let out = fs_grep("x".into(), "/".into(), None, None, None, Some(ssh));
        assert!(out.is_err());
    }
}
