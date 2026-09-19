use serde::{Deserialize, Serialize};

/// Docker identifiers: hex ids, names (`[a-zA-Z0-9][a-zA-Z0-9_.-]+`),
/// digests (`name@sha256:...`) and `repo:tag` refs. Anything else is
/// rejected before it can reach an argv.
pub const CONTAINER_ID_RE: &str = r"^[A-Za-z0-9][A-Za-z0-9_.\-:/@]*$";

pub fn validate_container_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 {
        return Err("docker identifier is empty or too long".into());
    }
    let ok = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ':' | '/' | '@'));
    let starts_ok = id
        .chars()
        .next()
        .map(|c| c.is_ascii_alphanumeric())
        .unwrap_or(false);
    if !ok || !starts_ok {
        return Err(format!("invalid docker identifier: {id}"));
    }
    Ok(())
}

/// Shells allowed for `docker exec -it <c> <shell>`. Fixed allow-list —
/// the frontend sends a key, never a path.
pub const ALLOWED_EXEC_SHELLS: &[&str] = &["sh", "bash", "ash", "zsh", "fish", "pwsh", "powershell"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainerShell {
    pub key: String,
    pub argv: String,
}

pub fn exec_shell_argv(shell_key: &str) -> Result<ContainerShell, String> {
    if !ALLOWED_EXEC_SHELLS.contains(&shell_key) {
        return Err(format!("exec shell not allowed: {shell_key}"));
    }
    Ok(ContainerShell {
        key: shell_key.to_string(),
        argv: shell_key.to_string(),
    })
}

/// argv for `docker exec -it <container> <shell>`. Container id validated,
/// shell from the fixed allow-list; no other user input enters the argv.
pub fn build_exec_argv(container: &str, shell_key: &str) -> Result<Vec<String>, String> {
    validate_container_id(container)?;
    let shell = exec_shell_argv(shell_key)?;
    Ok(vec![
        "docker".into(),
        "exec".into(),
        "-it".into(),
        container.into(),
        shell.argv,
    ])
}

/// argv for `docker attach [--no-stdin] <container>`.
pub fn build_attach_argv(container: &str, no_stdin: bool) -> Result<Vec<String>, String> {
    validate_container_id(container)?;
    let mut argv = vec!["docker".into(), "attach".into()];
    if no_stdin {
        argv.push("--no-stdin".into());
    }
    argv.push(container.into());
    Ok(argv)
}

/// Prune targets are enumerated — the frontend sends a key, never flags.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PruneTarget {
    Containers,
    Images,
    Volumes,
    Networks,
    Builder,
    System,
}

pub fn prune_target(key: &str) -> Result<PruneTarget, String> {
    match key {
        "containers" => Ok(PruneTarget::Containers),
        "images" => Ok(PruneTarget::Images),
        "volumes" => Ok(PruneTarget::Volumes),
        "networks" => Ok(PruneTarget::Networks),
        "builder" => Ok(PruneTarget::Builder),
        "system" => Ok(PruneTarget::System),
        _ => Err(format!("unknown prune target: {key}")),
    }
}

pub fn build_prune_argv(target: PruneTarget, all: bool, volumes: bool) -> Vec<String> {
    match target {
        PruneTarget::Containers => vec!["docker", "container", "prune", "-f"]
            .into_iter()
            .map(str::to_string)
            .collect(),
        PruneTarget::Images => {
            let mut v = vec!["docker".into(), "image".into(), "prune".into(), "-f".into()];
            if all {
                v.push("-a".into());
            }
            v
        }
        PruneTarget::Volumes => vec!["docker", "volume", "prune", "-f"]
            .into_iter()
            .map(str::to_string)
            .collect(),
        PruneTarget::Networks => vec!["docker", "network", "prune", "-f"]
            .into_iter()
            .map(str::to_string)
            .collect(),
        PruneTarget::Builder => vec!["docker", "builder", "prune", "-f"]
            .into_iter()
            .map(str::to_string)
            .collect(),
        PruneTarget::System => {
            let mut v = vec!["docker".into(), "system".into(), "prune".into(), "-f".into()];
            if all {
                v.push("-a".into());
            }
            if volumes {
                v.push("--volumes".into());
            }
            v
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_validator_accepts_names_digests_tags() {
        for ok in ["abc123", "web-1", "my_app.db", "nginx:latest", "reg.io:5000/img@sha256:abcd"] {
            validate_container_id(ok).expect(ok);
        }
    }

    #[test]
    fn id_validator_rejects_shell_metachars() {
        for bad in ["", "a b", "x;rm", "$(id)", "`id`", "a|b", "a&b", "../x", "-lead"] {
            assert!(validate_container_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn exec_argv_is_fixed_shape() {
        let argv = build_exec_argv("web-1", "bash").unwrap();
        assert_eq!(argv, vec!["docker", "exec", "-it", "web-1", "bash"]);
        assert!(build_exec_argv("web-1", "/bin/evil").is_err());
        assert!(build_exec_argv("a;b", "bash").is_err());
    }

    #[test]
    fn prune_argv_never_passes_user_flags() {
        assert_eq!(
            build_prune_argv(PruneTarget::System, true, true),
            vec!["docker", "system", "prune", "-f", "-a", "--volumes"]
        );
        assert!(prune_target("all; rm -rf /").is_err());
    }
}
