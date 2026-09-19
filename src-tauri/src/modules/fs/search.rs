pub use terax_core::fs::search::{rank_fuzzy, ListFilesResult, SearchHit, SearchResult};

use crate::modules::workspace::{require_local_workspace, resolve_path, WorkspaceEnv};

#[tauri::command]
pub fn fs_search(
    root: String,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<SearchResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let root_path = resolve_path(&root, &workspace);
    terax_core::fs::search::search_files(
        &root_path,
        &root,
        workspace.is_wsl(),
        &query,
        limit.unwrap_or(200),
        show_hidden.unwrap_or(false),
    )
}

#[tauri::command]
pub fn fs_list_files(
    root: String,
    limit: Option<usize>,
    max_depth: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<ListFilesResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    require_local_workspace(&workspace)?;
    let root_path = resolve_path(&root, &workspace);
    terax_core::fs::search::list_files(
        &root_path,
        &root,
        limit.unwrap_or(0),
        max_depth.unwrap_or(0),
        show_hidden.unwrap_or(false),
    )
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
}
