use serde::{Deserialize, Serialize};

/// One parsed `docker pull` progress line. The parser is best-effort: any
/// line it cannot classify becomes `Raw` so the UI always has a fallback.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PullProgressEvent {
    Layer {
        id: String,
        status: String,
        detail: String,
    },
    Status {
        text: String,
    },
    Digest {
        digest: String,
    },
    Done {
        reference: String,
    },
    Error {
        text: String,
    },
    Raw {
        text: String,
    },
}

/// Parse one stderr/stdout line from `docker pull`.
pub fn parse_pull_progress_line(line: &str) -> Option<PullProgressEvent> {
    let t = line.trim();
    if t.is_empty() {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("error") || lower.contains("error response") || lower.contains("denied") || lower.contains("unauthorized") {
        return Some(PullProgressEvent::Error { text: t.to_string() });
    }
    if let Some(rest) = t.strip_prefix("Digest:") {
        return Some(PullProgressEvent::Digest {
            digest: rest.trim().to_string(),
        });
    }
    if lower.starts_with("status:") {
        let text = t["status:".len()..].trim().to_string();
        // `Status: Downloaded newer image for nginx:latest` → Done.
        if text.to_ascii_lowercase().starts_with("downloaded newer image for ") {
            return Some(PullProgressEvent::Done {
                reference: text["Downloaded newer image for ".len()..].trim().to_string(),
            });
        }
        if text.to_ascii_lowercase().starts_with("image is up to date for ") {
            return Some(PullProgressEvent::Done {
                reference: text["Image is up to date for ".len()..].trim().to_string(),
            });
        }
        return Some(PullProgressEvent::Status { text });
    }
    // Layer lines: `<12-hex> <Status…>[: detail]`
    let mut parts = t.splitn(2, char::is_whitespace);
    let id = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim();
    if id.len() >= 6 && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit()) && !rest.is_empty() {
        let (status, detail) = match rest.split_once(':') {
            Some((s, d)) => (s.trim().to_string(), d.trim().to_string()),
            None => (rest.to_string(), String::new()),
        };
        return Some(PullProgressEvent::Layer { id: id.to_string(), status, detail });
    }
    Some(PullProgressEvent::Raw { text: t.to_string() })
}

/// Compare a local RepoDigest against `docker manifest inspect`'s digest
/// list. Returns true when the registry has something the host lacks.
pub fn registry_has_update(local_digest: &str, manifest_digests: &[String]) -> bool {
    if local_digest.is_empty() || manifest_digests.is_empty() {
        return false;
    }
    !manifest_digests.iter().any(|d| d == local_digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_layered_pull() {
        let ev = parse_pull_progress_line("e4c3d3e4f7c3 Pulling fs layer").unwrap();
        assert!(matches!(ev, PullProgressEvent::Layer { .. }));
        let ev = parse_pull_progress_line("e4c3d3e4f7c3 Downloading [====>   ]  4MB/12MB").unwrap();
        assert!(matches!(ev, PullProgressEvent::Layer { .. }));
    }

    #[test]
    fn parses_cached_and_digest_lines() {
        assert!(parse_pull_progress_line("").is_none());
        let ev = parse_pull_progress_line("Digest: sha256:abcd").unwrap();
        assert_eq!(ev, PullProgressEvent::Digest { digest: "sha256:abcd".into() });
        let ev = parse_pull_progress_line("Status: Downloaded newer image for nginx:latest").unwrap();
        assert_eq!(ev, PullProgressEvent::Done { reference: "nginx:latest".into() });
        let ev = parse_pull_progress_line("Status: Image is up to date for nginx:latest").unwrap();
        assert_eq!(ev, PullProgressEvent::Done { reference: "nginx:latest".into() });
    }

    #[test]
    fn parses_auth_failures_as_errors() {
        let ev = parse_pull_progress_line("Error response from daemon: pull access denied").unwrap();
        assert!(matches!(ev, PullProgressEvent::Error { .. }));
    }

    #[test]
    fn digest_compare_detects_updates() {
        assert!(registry_has_update("sha256:old", &["sha256:new".into()]));
        assert!(!registry_has_update("sha256:same", &["sha256:same".into()]));
        assert!(!registry_has_update("", &["sha256:x".into()]));
        assert!(!registry_has_update("sha256:x", &[]));
    }
}
