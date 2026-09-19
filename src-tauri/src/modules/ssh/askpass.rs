use std::path::PathBuf;

use super::errors::SshError;

const HELPER_TTL_SECS: u64 = 120;

/// One-shot SSH_ASKPASS helper. The master-start flow needs a non-terminal
/// password source; this writes a 0700 script + 0600 secret file into a
/// 0700 temp dir, hands the script path to ssh, then deletes everything.
/// Passwords never appear in argv, env, or logs.
pub struct AskpassGrant {
    pub script: PathBuf,
    dir: PathBuf,
}

const HELPER_SCRIPT_UNIX: &str = "#!/bin/sh\ncat \"$TERAX_ASKPASS_FILE\"\n";
const HELPER_SCRIPT_WINDOWS: &str = "@echo off\r\ntype \"%TERAX_ASKPASS_FILE%\"\r\n";

pub fn create_grant(secret: &str) -> Result<AskpassGrant, SshError> {
    if secret.is_empty() {
        return Err(SshError::Io {
            message: "askpass secret is empty".into(),
        });
    }
    let mut dir = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.push(format!("terax-askpass-{}-{nanos}", std::process::id()));
    std::fs::create_dir(&dir).map_err(|e| SshError::Io {
        message: format!("create askpass dir: {e}"),
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| {
            SshError::Io {
                message: format!("secure askpass dir: {e}"),
            }
        })?;
    }

    let secret_path = dir.join("secret");
    write_private(&secret_path, secret.as_bytes())?;
    let script_name = if cfg!(windows) { "askpass.cmd" } else { "askpass.sh" };
    let script_path = dir.join(script_name);
    let body = if cfg!(windows) {
        HELPER_SCRIPT_WINDOWS
    } else {
        HELPER_SCRIPT_UNIX
    };
    write_private(&script_path, body.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700)).map_err(
            |e| SshError::Io {
                message: format!("secure askpass script: {e}"),
            },
        )?;
    }

    let grant = AskpassGrant {
        script: script_path,
        dir,
    };
    grant.schedule_expiry();
    Ok(grant)
}

fn write_private(path: &PathBuf, bytes: &[u8]) -> Result<(), SshError> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| SshError::Io {
                message: format!("write askpass file: {e}"),
            })?;
        f.write_all(bytes).map_err(|e| SshError::Io {
            message: format!("write askpass file: {e}"),
        })?;
        f.sync_all().map_err(|e| SshError::Io {
            message: format!("sync askpass file: {e}"),
        })?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes).map_err(|e| SshError::Io {
            message: format!("write askpass file: {e}"),
        })
    }
}

impl AskpassGrant {
    pub fn secret_path(&self) -> PathBuf {
        self.dir.join("secret")
    }

    fn schedule_expiry(&self) {
        let dir = self.dir.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(HELPER_TTL_SECS));
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    pub fn destroy(self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Args for establishing the ControlMaster. When `askpass` is Some, ssh
/// reads the password from the helper instead of the terminal.
pub fn master_start_args(socket: &std::path::Path, host: &super::hosts::SshHost) -> Vec<String> {
    let mut args = vec![
        "-M".to_string(),
        "-S".to_string(),
        socket.to_string_lossy().into_owned(),
        "-f".to_string(),
        "-N".to_string(),
        "-o".to_string(),
        "ControlPersist=600".to_string(),
    ];
    for arg in super::session::terminal_base_args(host) {
        if arg == "-t" || arg == "BatchMode=yes" {
            continue;
        }
        args.push(arg);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_creates_and_destroys() {
        let grant = create_grant("s3cret").unwrap();
        assert!(grant.script.exists());
        assert!(grant.secret_path().exists());
        let secret = std::fs::read(&grant.secret_path()).unwrap();
        assert_eq!(secret, b"s3cret");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(grant.secret_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        let dir = grant.dir.clone();
        grant.destroy();
        assert!(!dir.exists());
    }

    #[test]
    fn rejects_empty_secret() {
        assert!(create_grant("").is_err());
    }
}
