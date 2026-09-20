use std::io::Read;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use serde::Serialize;
use shared_child::SharedChild;

use super::ringbuffer::BoundedRingBuffer;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const RING_CAP: usize = 4 * 1024 * 1024;

pub struct BackgroundProc {
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub child: Arc<SharedChild>,
    pub buffer: Mutex<BoundedRingBuffer>,
    pub exited: AtomicBool,
    pub exit_code: AtomicI32,
    pub exit_unknown: AtomicBool,
}

#[derive(Serialize)]
pub struct BackgroundLogResponse {
    pub bytes: String,
    pub next_offset: u64,
    pub dropped: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
    /// True when the payload was capped to fit the transport frame; the
    /// caller must re-poll with the returned `next_offset` for the rest.
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct BackgroundProcInfo {
    pub handle: u32,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

impl BackgroundProc {
    pub fn read_logs(&self, since: u64) -> BackgroundLogResponse {
        self.read_logs_capped(since, usize::MAX)
    }

    /// Floor `bytes` back to the last UTF-8 char boundary (mirrors
    /// terax-core's: continuation bytes are 0x80..0xC0).
    fn floor_char_boundary(bytes: &[u8]) -> usize {
        let mut cut = bytes.len();
        while cut > 0 && (bytes[cut - 1] & 0xC0) == 0x80 {
            cut -= 1;
        }
        if cut > 0 && (bytes[cut - 1] & 0xC0) == 0xC0 {
            let lead = bytes[cut - 1];
            let want = if lead >= 0xF0 {
                4
            } else if lead >= 0xE0 {
                3
            } else {
                2
            };
            if bytes.len() - (cut - 1) < want {
                cut -= 1;
            }
        }
        cut
    }

    /// Bounded variant (mirrors terax-core's): caps the payload so framed
    /// transports never blow their message cap. Local callers pass
    /// usize::MAX via read_logs; the SSH agent passes MAX_POLL_BYTES.
    pub fn read_logs_capped(&self, since: u64, limit: usize) -> BackgroundLogResponse {
        let guard = self.buffer.lock().unwrap();
        let (bytes, next_offset, dropped) = guard.read_from_limited(since, limit);
        let truncated = {
            let (_, full_next, _) = guard.read_from(since);
            full_next != next_offset
        };
        drop(guard);
        let cut = Self::floor_char_boundary(&bytes);
        let (bytes, next_offset) = if cut != bytes.len() {
            let guard = self.buffer.lock().unwrap();
            let (_, next, _) = guard.read_from_limited(since, cut);
            drop(guard);
            (bytes[..cut].to_vec(), next)
        } else {
            (bytes, next_offset)
        };
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundLogResponse {
            bytes: String::from_utf8_lossy(&bytes).into_owned(),
            next_offset,
            dropped,
            exited,
            exit_code,
            truncated,
        }
    }

    pub fn kill(&self) {
        let _ = self.child.kill();
    }

    pub fn info(&self, handle: u32) -> BackgroundProcInfo {
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundProcInfo {
            handle,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at_ms: self.started_at_ms,
            exited,
            exit_code,
        }
    }
}

impl Drop for BackgroundProc {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn spawn(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
) -> Result<Arc<BackgroundProc>, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if let Some(ref dir) = cwd {
        if !resolve_path(dir, &workspace).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }

    let mut cmd = super::build_oneshot_command(&trimmed, &workspace, cwd.as_deref())?;
    if let (WorkspaceEnv::Local, Some(ref dir)) = (&workspace, &cwd) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let shared = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?);
    let kill_on_fail = || {
        let _ = shared.kill();
    };
    let stdout_pipe = shared.take_stdout().ok_or_else(|| {
        kill_on_fail();
        "no stdout pipe".to_string()
    })?;
    let stderr_pipe = shared.take_stderr().ok_or_else(|| {
        kill_on_fail();
        "no stderr pipe".to_string()
    })?;
    let child = shared;

    let started_at_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let proc = Arc::new(BackgroundProc {
        command: trimmed,
        cwd,
        started_at_ms,
        child,
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
    });

    {
        let proc_ref = proc.clone();
        let mut pipe = stdout_pipe;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => proc_ref.buffer.lock().unwrap().push(&buf[..n]),
                    Err(_) => break,
                }
            }
        });
    }
    {
        let proc_ref = proc.clone();
        let mut pipe = stderr_pipe;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => proc_ref.buffer.lock().unwrap().push(&buf[..n]),
                    Err(_) => break,
                }
            }
        });
    }
    {
        let proc_ref = proc.clone();
        let child_for_wait = proc.child.clone();
        thread::spawn(move || {
            match child_for_wait.wait() {
                Ok(status) => match status.code() {
                    Some(code) => proc_ref.exit_code.store(code, Ordering::Release),
                    None => proc_ref.exit_unknown.store(true, Ordering::Release),
                },
                Err(_) => proc_ref.exit_unknown.store(true, Ordering::Release),
            }
            proc_ref.exited.store(true, Ordering::Release);
        });
    }

    Ok(proc)
}
