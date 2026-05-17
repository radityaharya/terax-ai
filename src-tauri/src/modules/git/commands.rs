use crate::modules::git::operations;
use crate::modules::git::types::{
    DiscardEntry, GitCommitFileChange, GitCommitResult, GitDiffContentResult, GitDiffResult,
    GitLogEntry, GitPanelSnapshot, GitPushResult, GitRepoInfo, GitStatusSnapshot,
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

#[tauri::command]
pub async fn git_log(
    repo_root: String,
    limit: Option<u32>,
    before_sha: Option<String>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Vec<GitLogEntry>, String> {
    operations::log(
        &registry,
        &repo_root,
        limit.unwrap_or(30),
        before_sha.as_deref(),
    )
    .map_err(Into::into)
}

#[tauri::command]
pub async fn git_show_commit(
    repo_root: String,
    sha: String,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<GitDiffResult, String> {
    operations::show_commit_diff(&registry, &repo_root, &sha).map_err(Into::into)
}

#[tauri::command]
pub async fn git_commit_files(
    repo_root: String,
    sha: String,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Vec<GitCommitFileChange>, String> {
    operations::commit_files(&registry, &repo_root, &sha).map_err(Into::into)
}

#[tauri::command]
pub async fn git_commit_file_diff(
    repo_root: String,
    sha: String,
    path: String,
    original_path: Option<String>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<GitDiffContentResult, String> {
    operations::commit_file_diff(
        &registry,
        &repo_root,
        &sha,
        &path,
        original_path.as_deref(),
    )
    .map_err(Into::into)
}

#[tauri::command]
pub async fn git_remote_url(
    repo_root: String,
    name: Option<String>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Option<String>, String> {
    let remote = name.unwrap_or_else(|| "origin".to_string());
    operations::remote_url(&registry, &repo_root, &remote).map_err(Into::into)
}
