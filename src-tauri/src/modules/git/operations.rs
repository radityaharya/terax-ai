use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::parser::{parse_branch_header, parse_changed_files};
use crate::modules::git::process::{
    ensure_git_available, ensure_success, git_show_text, git_stdout_line_opt, git_stdout_lines,
    read_text_file, run_git,
};
use crate::modules::git::types::{
    DiscardEntry, GitCommitResult, GitDiffContentResult, GitDiffResult, GitOutput,
    GitPanelSnapshot, GitPushResult, GitRepoInfo, GitStatusSnapshot, TextSource,
    DEFAULT_TIMEOUT_SECS, NETWORK_TIMEOUT_SECS,
};
use crate::modules::git::utils::{
    authorized_repo_root, canonical_dir, display_path, resolve_within_repo, split_upstream,
};
use crate::modules::workspace::WorkspaceRegistry;

pub fn resolve_repo(registry: &WorkspaceRegistry, cwd: &str) -> Result<Option<GitRepoInfo>> {
    let cwd = canonical_dir(cwd)?;
    if !registry.is_authorized(&cwd) {
        return Err(GitError::PathOutsideWorkspace(cwd));
    }
    ensure_git_available()?;
    resolve_repo_in_authorized(registry, &cwd)
}

fn resolve_repo_in_authorized(
    registry: &WorkspaceRegistry,
    cwd: &Path,
) -> Result<Option<GitRepoInfo>> {
    // Single git invocation returns toplevel, HEAD ref and @{u} (if any).
    // The @{u} arg may fail for branches with no upstream, so we issue it
    // separately and treat absence as None — fast path stays one process.
    let Some(root_line) = git_stdout_line_opt(cwd, ["rev-parse", "--show-toplevel"])? else {
        return Ok(None);
    };
    let canonical_root = canonical_dir(&root_line)?;
    let _ = registry.authorize(&canonical_root);

    let basics = git_stdout_lines(
        &canonical_root,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )?;
    let head = basics
        .into_iter()
        .next()
        .ok_or(GitError::CommandFailed {
            context: "failed to resolve HEAD",
            detail: String::new(),
        })?;

    let upstream = git_stdout_line_opt(
        &canonical_root,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;

    Ok(Some(GitRepoInfo {
        repo_root: display_path(&canonical_root),
        branch: head.clone(),
        upstream,
        is_detached: head == "HEAD",
    }))
}

pub fn panel_snapshot(registry: &WorkspaceRegistry, cwd: &str) -> Result<GitPanelSnapshot> {
    let cwd = canonical_dir(cwd)?;
    if !registry.is_authorized(&cwd) {
        return Err(GitError::PathOutsideWorkspace(cwd));
    }
    ensure_git_available()?;
    let Some(repo) = resolve_repo_in_authorized(registry, &cwd)? else {
        return Ok(GitPanelSnapshot {
            repo: None,
            status: None,
        });
    };
    let repo_path = PathBuf::from(&repo.repo_root);
    let status = status_inner(&repo_path)?;
    Ok(GitPanelSnapshot {
        repo: Some(repo),
        status: Some(status),
    })
}

pub fn status(registry: &WorkspaceRegistry, repo_root: &str) -> Result<GitStatusSnapshot> {
    let repo_root = authorized_repo_root(registry, repo_root)?;
    ensure_git_available()?;
    status_inner(&repo_root)
}

fn status_inner(repo_root: &Path) -> Result<GitStatusSnapshot> {
    let output = run_git(
        Some(repo_root),
        [
            "status",
            "--porcelain=v1",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git status failed")?;

    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let fields: Vec<&str> = stdout.split('\0').filter(|s| !s.is_empty()).collect();
    if fields.is_empty() {
        return Err(GitError::command("git status", "no data"));
    }

    let (branch, upstream, ahead, behind, is_detached) = parse_branch_header(fields[0])?;

    Ok(GitStatusSnapshot {
        repo_root: display_path(repo_root),
        branch,
        upstream,
        ahead,
        behind,
        is_detached,
        truncated: output.truncated,
        changed_files: parse_changed_files(&fields),
    })
}

pub fn diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: Option<&str>,
    staged: bool,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root)?;
    ensure_git_available()?;
    diff_inner(&repo_root, path, staged)
}

fn diff_inner(repo_root: &Path, path: Option<&str>, staged: bool) -> Result<GitDiffResult> {
    let mut args: Vec<&OsStr> = vec![OsStr::new("diff"), OsStr::new("--no-ext-diff")];
    if staged {
        args.push(OsStr::new("--cached"));
    }
    let resolved_path = match path.filter(|p| !p.is_empty()) {
        Some(p) => Some(resolve_within_repo(repo_root, p)?),
        None => None,
    };
    if let Some(p) = resolved_path.as_ref() {
        args.push(OsStr::new("--"));
        args.push(p.as_os_str());
    }
    let output = run_git(Some(repo_root), args, DEFAULT_TIMEOUT_SECS)?;
    ensure_success(&output, "git diff failed")?;

    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

pub fn diff_content(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: &str,
    staged: bool,
    original_path: Option<&str>,
) -> Result<GitDiffContentResult> {
    let repo_root = authorized_repo_root(registry, repo_root)?;
    ensure_git_available()?;
    let worktree_path = resolve_within_repo(&repo_root, path)?;
    let rel_path = pathspec(&repo_root, &worktree_path);

    let original_rel = match original_path {
        Some(orig) if !orig.is_empty() => {
            let resolved = resolve_within_repo(&repo_root, orig)?;
            Some(pathspec(&repo_root, &resolved))
        }
        _ => None,
    };

    let original = if staged {
        let spec = original_rel.as_deref().unwrap_or(&rel_path);
        git_show_text(&repo_root, &format!("HEAD:{spec}"))?
    } else {
        git_show_text(&repo_root, &format!(":{rel_path}"))?
    };
    let modified = if staged {
        git_show_text(&repo_root, &format!(":{rel_path}"))?
    } else {
        read_text_file(&worktree_path)?
    };
    let patch = diff_inner(&repo_root, Some(&rel_path), staged)?;
    let is_binary =
        matches!(original, TextSource::Binary) || matches!(modified, TextSource::Binary);

    Ok(GitDiffContentResult {
        original_content: original.into_text(),
        modified_content: modified.into_text(),
        is_binary,
        fallback_patch: patch.diff_text,
        truncated: patch.truncated,
    })
}

pub fn stage(registry: &WorkspaceRegistry, repo_root: &str, paths: &[String]) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root)?;
    ensure_git_available()?;
    if paths.is_empty() {
        return Ok(());
    }
    let resolved = resolve_paths(&repo_root, paths)?;
    let mut args: Vec<&OsStr> = vec![OsStr::new("add"), OsStr::new("--")];
    for p in &resolved {
        args.push(p.as_os_str());
    }
    let output = run_git(Some(&repo_root), args, DEFAULT_TIMEOUT_SECS)?;
    ensure_success(&output, "git add failed")
}

pub fn unstage(registry: &WorkspaceRegistry, repo_root: &str, paths: &[String]) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root)?;
    ensure_git_available()?;
    if paths.is_empty() {
        return Ok(());
    }
    let resolved = resolve_paths(&repo_root, paths)?;
    let has_head = git_stdout_line_opt(&repo_root, ["rev-parse", "--verify", "HEAD"])?.is_some();
    let mut args: Vec<&OsStr> = if has_head {
        vec![OsStr::new("reset"), OsStr::new("HEAD"), OsStr::new("--")]
    } else {
        vec![
            OsStr::new("rm"),
            OsStr::new("--cached"),
            OsStr::new("-r"),
            OsStr::new("--"),
        ]
    };
    for p in &resolved {
        args.push(p.as_os_str());
    }
    let output = run_git(Some(&repo_root), args, DEFAULT_TIMEOUT_SECS)?;
    ensure_success(
        &output,
        if has_head {
            "git reset failed"
        } else {
            "git rm --cached failed"
        },
    )
}

pub fn discard(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    entries: &[DiscardEntry],
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root)?;
    ensure_git_available()?;
    if entries.is_empty() {
        return Ok(());
    }

    let mut tracked: Vec<PathBuf> = Vec::with_capacity(entries.len());
    let mut untracked: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let resolved = resolve_within_repo(&repo_root, &entry.path)?;
        if entry.untracked {
            untracked.push(resolved);
        } else {
            tracked.push(resolved);
        }
    }

    if !tracked.is_empty() {
        let mut args: Vec<&OsStr> = vec![
            OsStr::new("restore"),
            OsStr::new("--worktree"),
            OsStr::new("--"),
        ];
        for p in &tracked {
            args.push(p.as_os_str());
        }
        let output = run_git(Some(&repo_root), args, DEFAULT_TIMEOUT_SECS)?;
        ensure_success(&output, "git restore failed")?;
    }

    if !untracked.is_empty() {
        let mut args: Vec<&OsStr> = vec![
            OsStr::new("clean"),
            OsStr::new("-f"),
            OsStr::new("-d"),
            OsStr::new("--"),
        ];
        for p in &untracked {
            args.push(p.as_os_str());
        }
        let output = run_git(Some(&repo_root), args, DEFAULT_TIMEOUT_SECS)?;
        ensure_success(&output, "git clean failed")?;
    }

    Ok(())
}

pub fn commit(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    message: &str,
) -> Result<GitCommitResult> {
    let repo_root = authorized_repo_root(registry, repo_root)?;
    ensure_git_available()?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(GitError::EmptyCommitMessage);
    }

    let output = run_git(
        Some(&repo_root),
        [OsStr::new("commit"), OsStr::new("-m"), OsStr::new(trimmed)],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.exit_code != Some(0) && nothing_to_commit(&output) {
        return Err(GitError::command("git commit", "nothing staged"));
    }
    ensure_success(&output, "git commit failed")?;

    let combined = git_stdout_lines(
        &repo_root,
        ["show", "-s", "--format=%H%n%s", "HEAD"],
    )?;
    let sha = combined
        .first()
        .cloned()
        .ok_or(GitError::CommandFailed {
            context: "failed to resolve commit sha",
            detail: String::new(),
        })?;
    let summary = combined.get(1).cloned().unwrap_or_default();

    Ok(GitCommitResult {
        commit_sha: sha,
        summary,
    })
}

pub fn push(registry: &WorkspaceRegistry, repo_root: &str) -> Result<GitPushResult> {
    let repo_root = authorized_repo_root(registry, repo_root)?;
    ensure_git_available()?;

    let upstream = git_stdout_line_opt(
        &repo_root,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;
    if upstream.is_none() {
        return Err(GitError::NoUpstream);
    }

    let output = run_git(Some(&repo_root), ["push"], NETWORK_TIMEOUT_SECS)?;
    ensure_success(&output, "git push failed")?;

    let upstream = upstream.unwrap();
    let (remote, branch) = split_upstream(&upstream);
    Ok(GitPushResult {
        remote,
        branch,
        pushed: true,
    })
}

pub fn fetch(registry: &WorkspaceRegistry, repo_root: &str) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root)?;
    ensure_git_available()?;
    let output = run_git(Some(&repo_root), ["fetch", "--prune"], NETWORK_TIMEOUT_SECS)?;
    ensure_success(&output, "git fetch failed")
}

pub fn pull_ff_only(registry: &WorkspaceRegistry, repo_root: &str) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root)?;
    ensure_git_available()?;
    let output = run_git(Some(&repo_root), ["pull", "--ff-only"], NETWORK_TIMEOUT_SECS)?;
    ensure_success(&output, "git pull --ff-only failed")
}

fn nothing_to_commit(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    stderr.contains("nothing to commit") || stdout.contains("nothing to commit")
}

fn resolve_paths(repo_root: &Path, paths: &[String]) -> Result<Vec<PathBuf>> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        out.push(resolve_within_repo(repo_root, p)?);
    }
    Ok(out)
}

fn pathspec(repo_root: &Path, absolute: &Path) -> String {
    absolute
        .strip_prefix(repo_root)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| absolute.to_string_lossy().replace('\\', "/"))
}
