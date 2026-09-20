use serde::{Deserialize, Serialize};

/// Replica mismatch between desired and running — the core swarm health
/// signal the panel surfaces per service.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaHealth {
    pub desired: u64,
    pub running: u64,
}

impl ReplicaHealth {
    pub fn under_replicated(&self) -> bool {
        self.running < self.desired
    }
}

/// Parse `docker service ls --format json` replicas field ("3/3").
pub fn parse_replicas(field: &str) -> ReplicaHealth {
    let (r, d) = field.split_once('/').unwrap_or(("0", "0"));
    ReplicaHealth {
        running: r.trim().parse().unwrap_or(0),
        desired: d.trim().parse().unwrap_or(0),
    }
}

/// Drift between a stack's running spec and its compose file: the agent
/// compares `docker stack services` image digests against the file's
/// `image:` pins. This helper just normalizes image refs for compare.
pub fn normalize_image_ref(image: &str) -> String {
    // `nginx` → `docker.io/library/nginx:latest`, explicit refs untouched.
    if image.contains('/') || image.contains(':') || image.contains('@') {
        return image.to_string();
    }
    format!("docker.io/library/{image}:latest")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replicas_parse_and_flag() {
        let h = parse_replicas("2/3");
        assert!(h.under_replicated());
        assert_eq!((h.running, h.desired), (2, 3));
        assert!(!parse_replicas("3/3").under_replicated());
        assert!(!parse_replicas("garbage").under_replicated());
    }

    #[test]
    fn drift_fixtures_normalize() {
        assert_eq!(normalize_image_ref("nginx"), "docker.io/library/nginx:latest");
        assert_eq!(normalize_image_ref("nginx:1.27"), "nginx:1.27");
        assert_eq!(
            normalize_image_ref("reg.io:5000/a@sha256:x"),
            "reg.io:5000/a@sha256:x"
        );
    }
}
