/// Compose project discovery + command shapes. The agent resolves paths
/// against its authorized root before running anything; this module owns
/// the argv shapes and the v2/v1 divergence.
pub const COMPOSE_FILENAMES: &[&str] = &[
    "compose.yml",
    "compose.yaml",
    "docker-compose.yml",
    "docker-compose.yaml",
];

/// argv prefix for compose: v2 plugin (`docker compose`) preferred, legacy
/// `docker-compose` binary as fallback (decided from capabilities).
pub fn compose_prefix(use_v2: bool) -> Vec<String> {
    if use_v2 {
        vec!["docker".into(), "compose".into()]
    } else {
        vec!["docker-compose".into()]
    }
}

/// Append `-f <file>` (repeatable) and `--project-directory` to a compose
/// prefix. Files are validated upstream by the agent's authorized() gate.
pub fn with_files(mut prefix: Vec<String>, files: &[String]) -> Vec<String> {
    for f in files {
        prefix.push("-f".into());
        prefix.push(f.clone());
    }
    prefix
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_prefers_v2() {
        assert_eq!(compose_prefix(true), vec!["docker", "compose"]);
        assert_eq!(compose_prefix(false), vec!["docker-compose"]);
    }

    #[test]
    fn files_append_in_order() {
        let argv = with_files(compose_prefix(true), &["a.yml".into(), "b.yml".into()]);
        assert_eq!(argv, vec!["docker", "compose", "-f", "a.yml", "-f", "b.yml"]);
    }
}
