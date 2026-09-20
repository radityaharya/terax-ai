use std::io::Read;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use shared_child::SharedChild;

use super::ringbuffer::BoundedRingBuffer;
use super::build_oneshot_command;
use crate::proc::hide_console;

pub const RING_CAP: usize = 4 * 1024 * 1024;

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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackgroundLogResponse {
    pub bytes: String,
    pub next_offset: u64,
    pub dropped: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
    /// True when the payload was capped to fit the transport frame; the
    /// caller must re-poll with the returned `next_offset` for the rest.
    /// Defaults false for old serialized payloads.
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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

    /// Bounded variant: caps the returned payload at `limit` bytes so the
    /// JSON frame can never exceed the transport cap. `truncated` tells the
    /// caller to re-poll for the remainder; `next_offset` always advances
    /// past the bytes actually returned, so no data is skipped or repeated.
    /// Floor `bytes` back to the last UTF-8 char boundary (UTF-8
    /// continuation bytes are 0x80..0xC0; a cut inside a multi-byte sequence
    /// ends with 1-3 of them after the lead byte).
    fn floor_char_boundary(bytes: &[u8]) -> usize {
        let mut cut = bytes.len();
        while cut > 0 && (bytes[cut - 1] & 0xC0) == 0x80 {
            cut -= 1;
        }
        // If we backed past the lead byte entirely, the whole tail is a
        // partial sequence — drop it (the bytes stay buffered; the next
        // poll re-reads them whole once the lead byte arrives).
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

    pub fn read_logs_capped(&self, since: u64, limit: usize) -> BackgroundLogResponse {
        let guard = self.buffer.lock().unwrap();
        // Single authoritative read: the limited variant both truncates and
        // derives the follow offset from the kept prefix, so chunk N+1
        // resumes exactly where chunk N stopped — no gaps, no repeats.
        let (bytes, next_offset, dropped) = guard.read_from_limited(since, limit);
        let truncated = {
            let (_, full_next, _) = guard.read_from(since);
            full_next != next_offset
        };
        drop(guard);
        // Floor the cut to a UTF-8 boundary so from_utf8 never fails
        // mid-codepoint; re-derive the offset for the shortened prefix.
        // (Lossy conversion would hide the split but corrupt the offset
        // chain — flooring keeps offsets byte-exact.)
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

impl BackgroundProc {
    /// Test-only constructor: a proc with pre-filled ring content backed by
    /// an instantly-exiting child. Lets harness tests cover the
    /// poll-chaining contract without depending on shells or pipe timing.
    ///
    /// NOT #[cfg(test)]-gated: terax-remote's harness tests (a downstream
    /// crate) use it, and cfg(test) only compiles for the defining crate's
    /// own tests. The name marks it test-only by convention.
    pub fn for_test(content: &[u8]) -> Arc<Self> {
        let cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.arg("/c").arg("exit").arg("0");
            c
        } else {
            std::process::Command::new("true")
        };
        // spawn_with applies hide_console (CREATE_NO_WINDOW on Windows), so
        // tests never flash consoles.
        let proc = spawn_with(cmd, "for_test".into(), None).expect("test spawn works");
        proc.buffer.lock().unwrap().push(content);
        proc
    }
}

pub fn spawn(command: String, cwd: Option<String>) -> Result<Arc<BackgroundProc>, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if let Some(ref dir) = cwd {
        if !std::path::PathBuf::from(dir).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }

    let cmd = build_oneshot_command(&trimmed, cwd.as_deref())?;
    spawn_with(cmd, trimmed, cwd)
}

/// Spawn a pre-built argv directly (no shell). Use for server-assembled
/// argv (e.g. docker) so validated identifiers can never meet a shell.
pub fn spawn_argv(argv: Vec<String>, cwd: Option<String>) -> Result<Arc<BackgroundProc>, String> {
    if argv.is_empty() || argv[0].trim().is_empty() {
        return Err("empty command".into());
    }
    if let Some(ref dir) = cwd {
        if !std::path::PathBuf::from(dir).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }
    let label = argv.join(" ");
    let mut cmd = std::process::Command::new(&argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    spawn_with(cmd, label, cwd)
}

fn spawn_with(
    mut cmd: std::process::Command,
    label: String,
    cwd: Option<String>,
) -> Result<Arc<BackgroundProc>, String> {
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);

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
        command: label,
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
