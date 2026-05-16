use crate::modules::git::operations;
use crate::modules::git::types::{
    DiscardEntry, GitCommitResult, GitDiffContentResult, GitDiffResult, GitPanelSnapshot,
    GitPushResult, GitRepoInfo, GitStatusSnapshot,
};
use crate::modules::workspace::WorkspaceRegistry;

#[tauri::command]
pub async fn git_resolve_repo(
    cwd: String,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Option<GitRepoInfo>, String> {
    operations::resolve_repo(&registry, &cwd).map_err(Into::into)
}

#[tauri::command]
pub async fn git_panel_snapshot(
    cwd: String,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<GitPanelSnapshot, String> {
    operations::panel_snapshot(&registry, &cwd).map_err(Into::into)
}

#[tauri::command]
pub async fn git_status(
    repo_root: String,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<GitStatusSnapshot, String> {
    operations::status(&registry, &repo_root).map_err(Into::into)
}

#[tauri::command]
pub async fn git_diff(
    repo_root: String,
    path: Option<String>,
    staged: bool,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<GitDiffResult, String> {
    operations::diff(&registry, &repo_root, path.as_deref(), staged).map_err(Into::into)
}

#[tauri::command]
pub async fn git_diff_content(
    repo_root: String,
    path: String,
    staged: bool,
    original_path: Option<String>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<GitDiffContentResult, String> {
    operations::diff_content(&registry, &repo_root, &path, staged, original_path.as_deref())
        .map_err(Into::into)
}

#[tauri::command]
pub async fn git_stage(
    repo_root: String,
    paths: Vec<String>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    operations::stage(&registry, &repo_root, &paths).map_err(Into::into)
}

#[tauri::command]
pub async fn git_unstage(
    repo_root: String,
    paths: Vec<String>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    operations::unstage(&registry, &repo_root, &paths).map_err(Into::into)
}

#[tauri::command]
pub async fn git_discard(
    repo_root: String,
    entries: Vec<DiscardEntry>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    operations::discard(&registry, &repo_root, &entries).map_err(Into::into)
}

#[tauri::command]
pub async fn git_commit(
    repo_root: String,
    message: String,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<GitCommitResult, String> {
    operations::commit(&registry, &repo_root, &message).map_err(Into::into)
}

#[tauri::command]
pub async fn git_fetch(
    repo_root: String,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    operations::fetch(&registry, &repo_root).map_err(Into::into)
}

#[tauri::command]
pub async fn git_pull_ff_only(
    repo_root: String,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    operations::pull_ff_only(&registry, &repo_root).map_err(Into::into)
}

#[tauri::command]
pub async fn git_push(
    repo_root: String,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<GitPushResult, String> {
    operations::push(&registry, &repo_root).map_err(Into::into)
}
