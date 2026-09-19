use std::path::Path;

use ignore::WalkBuilder;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};

use super::super::canon::to_canon;

#[derive(Serialize, Deserialize, Clone)]
pub struct SearchHit {
    /// Absolute path of the matched file.
    pub path: String,
    /// Path relative to the search root, for display.
    pub rel: String,
    /// File name only.
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize, Deserialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// True if the scan stopped early (entry budget or hit cap reached).
    pub truncated: bool,
}

/// Hard cap on entries the walker is allowed to visit before bailing. Protects
/// against pathological roots like $HOME where there's no .gitignore and the
/// tree is effectively unbounded.
pub const MAX_SCANNED: usize = 50_000;

/// Directory names pruned unconditionally — they're rarely useful in a
/// file-explorer search and they dominate scan time when present.
pub const PRUNE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "__pycache__",
];

/// Fuzzy search under an already-resolved `root`. `root_display` is the
/// caller-visible root string used to build hit paths. On the desktop this
/// is the workspace-relative display root; on the remote agent it is the
/// remote root itself.
pub fn search_files(
    root_path: &Path,
    root_display: &str,
    remote_style: bool,
    query: &str,
    limit: usize,
    show_hidden: bool,
) -> Result<SearchResult, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let cap = limit.min(1000);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root_display}"));
    }

    let mut cands: Vec<SearchHit> = Vec::new();
    let mut scanned: usize = 0;
    let mut truncated = false;

    let walker = WalkBuilder::new(root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .filter_entry(|dent| {
            // Prune known-heavy dirs even when no .gitignore is present (e.g.
            // searching from $HOME).
            if dent.depth() == 0 {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build();

    for dent in walker.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            truncated = true;
            break;
        }
        let path = dent.path();
        if path == root_path {
            continue;
        }
        let rel = match path.strip_prefix(root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        cands.push(SearchHit {
            path: display_path(path, root_path, root_display, remote_style),
            rel,
            name,
            is_dir,
        });
    }

    let hits = rank_fuzzy(cands, q, cap);
    Ok(SearchResult { hits, truncated })
}

/// Fuzzy-rank candidates against the query (path-aware, smart-case), keeping
/// the top `cap`. Ties break toward shorter relative paths.
pub fn rank_fuzzy(cands: Vec<SearchHit>, query: &str, cap: usize) -> Vec<SearchHit> {
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut buf = Vec::new();

    let mut scored = Vec::with_capacity(cands.len());
    for (i, c) in cands.iter().enumerate() {
        if let Some(s) = pattern.score(Utf32Str::new(&c.rel, &mut buf), &mut matcher) {
            scored.push((s, i));
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| cands[a.1].rel.len().cmp(&cands[b.1].rel.len()))
    });
    scored
        .into_iter()
        .take(cap)
        .map(|(_, i)| cands[i].clone())
        .collect()
}

#[derive(Serialize, Deserialize)]
pub struct ListFilesResult {
    pub files: Vec<String>,
    pub truncated: bool,
}

pub fn list_files(
    root_path: &Path,
    root_display: &str,
    limit: usize,
    max_depth: usize,
    show_hidden: bool,
) -> Result<ListFilesResult, String> {
    const DEFAULT_LIMIT: usize = 2_000;
    const HARD_LIMIT: usize = 10_000;
    const DEFAULT_DEPTH: usize = 8;
    const HARD_DEPTH: usize = 16;

    let cap = if limit == 0 { DEFAULT_LIMIT } else { limit.clamp(1, HARD_LIMIT) };
    let depth = if max_depth == 0 {
        DEFAULT_DEPTH
    } else {
        max_depth.clamp(1, HARD_DEPTH)
    };
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root_display}"));
    }

    let walker = WalkBuilder::new(root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .max_depth(Some(depth))
        .filter_entry(|dent| {
            if dent.depth() == 0 {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build();

    let mut files: Vec<String> = Vec::with_capacity(cap.min(256));
    let mut scanned: usize = 0;
    let mut truncated = false;

    for dent in walker.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            truncated = true;
            break;
        }
        let is_file = dent.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let path = dent.path();
        let rel = match path.strip_prefix(root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        files.push(rel);
        if files.len() >= cap {
            truncated = true;
            break;
        }
    }

    files.sort_by_key(|a| a.to_lowercase());
    Ok(ListFilesResult { files, truncated })
}

fn display_path(path: &Path, root_path: &Path, root_display: &str, remote_style: bool) -> String {
    if remote_style {
        if let Ok(rel) = path.strip_prefix(root_path) {
            let rel = to_canon(rel);
            return if rel.is_empty() {
                root_display.to_string()
            } else if root_display.ends_with('/') {
                format!("{root_display}{rel}")
            } else {
                format!("{root_display}/{rel}")
            };
        }
    }
    to_canon(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(rel: &str) -> SearchHit {
        SearchHit {
            path: rel.to_string(),
            rel: rel.to_string(),
            name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
            is_dir: false,
        }
    }

    #[test]
    fn rank_fuzzy_prefers_name_and_shorter_path() {
        let cands = vec![
            hit("src/deeply/nested/config.rs"),
            hit("config.rs"),
            hit("src/main.rs"),
        ];
        let out = rank_fuzzy(cands, "config", 10);
        assert_eq!(out[0].rel, "config.rs");
        assert!(!out.iter().any(|h| h.rel == "src/main.rs"));
    }

    #[test]
    fn rank_fuzzy_matches_subsequence() {
        let cands = vec![hit("CommandPalette.tsx"), hit("readme.md")];
        let out = rank_fuzzy(cands, "cmdp", 10);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rel, "CommandPalette.tsx");
    }

    #[test]
    fn search_files_finds_by_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.rs"), b"fn main(){}").unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let res = search_files(dir.path(), &root, false, "hello", 200, false).unwrap();
        assert_eq!(res.hits.len(), 1);
        assert!(res.hits[0].rel.ends_with("hello.rs"));
    }
}
