use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, Ordering};

/// Desktop-side per-host Docker state (v1: SSH hosts only). The actual
/// Docker work runs on the remote agent over the existing RPC channel;
/// this state tracks in-flight long-running operations the desktop
/// spawned (pull progress handles, log follows) so polls route to the
/// right host lane.
#[derive(Default)]
pub struct DockerShared {
    /// host_id -> pull/event/log handles currently followed by the UI.
    pub followed: Mutex<HashMap<String, Vec<u32>>>,
    next_local: AtomicU32,
}

impl DockerShared {
    pub fn track(&self, host_id: &str, handle: u32) {
        self.followed
            .lock()
            .unwrap()
            .entry(host_id.to_string())
            .or_default()
            .push(handle);
    }

    pub fn untrack(&self, host_id: &str, handle: u32) {
        if let Some(v) = self.followed.lock().unwrap().get_mut(host_id) {
            v.retain(|h| *h != handle);
        }
    }

    pub fn untrack_host(&self, host_id: &str) {
        self.followed.lock().unwrap().remove(host_id);
    }

    pub fn alloc_local(&self) -> u32 {
        self.next_local.fetch_add(1, Ordering::Relaxed)
    }
}

/// Snapshot for diagnostics; never carries secrets.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerDiagnostics {
    pub hosts_tracked: usize,
    pub handles_tracked: usize,
}

pub fn diagnostics(shared: &DockerShared) -> DockerDiagnostics {
    let map = shared.followed.lock().unwrap();
    DockerDiagnostics {
        hosts_tracked: map.len(),
        handles_tracked: map.values().map(Vec::len).sum(),
    }
}

pub fn drop_host(shared: &Arc<DockerShared>, host_id: &str) {
    shared.untrack_host(host_id);
}
