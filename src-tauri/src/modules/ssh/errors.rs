use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthHint {
    PublicKeyDenied,
    PasswordRequired,
    KeyboardInteractive,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum SshError {
    NotInstalled {
        message: String,
    },
    AuthRequired {
        message: String,
        hint: AuthHint,
    },
    HostKey {
        message: String,
        trusted: bool,
    },
    TimedOut {
        message: String,
    },
    UnsafeHost {
        message: String,
    },
    Spawn {
        message: String,
    },
    CommandFailed {
        message: String,
    },
    Io {
        message: String,
    },
}

impl SshError {
    pub fn message(&self) -> &str {
        match self {
            SshError::NotInstalled { message }
            | SshError::AuthRequired { message, .. }
            | SshError::HostKey { message, .. }
            | SshError::TimedOut { message }
            | SshError::UnsafeHost { message }
            | SshError::Spawn { message }
            | SshError::CommandFailed { message }
            | SshError::Io { message } => message,
        }
    }
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message())
    }
}

impl std::error::Error for SshError {}

pub fn classify_stderr(stderr: &str) -> Option<SshError> {
    let lower = stderr.to_ascii_lowercase();
    let first = stderr.lines().next().unwrap_or(stderr).trim().to_string();
    if lower.contains("host key verification failed") {
        return Some(SshError::HostKey {
            message: first,
            trusted: false,
        });
    }
    if lower.contains("no matching host key type found")
        || lower.contains("no matching key exchange method found")
        || lower.contains("no matching cipher found")
    {
        return Some(SshError::HostKey {
            message: first,
            trusted: false,
        });
    }
    if lower.contains("permission denied (publickey")
        || lower.contains("permission denied (publickey,")
    {
        return Some(SshError::AuthRequired {
            message: first,
            hint: AuthHint::PublicKeyDenied,
        });
    }
    if lower.contains("permission denied, please try again")
        || lower.contains("permission denied (password")
    {
        return Some(SshError::AuthRequired {
            message: first,
            hint: AuthHint::PasswordRequired,
        });
    }
    if lower.contains("keyboard-interactive") && lower.contains("permission denied") {
        return Some(SshError::AuthRequired {
            message: first,
            hint: AuthHint::KeyboardInteractive,
        });
    }
    if lower.contains("verification failed")
        && (lower.contains("2fa") || lower.contains("two-factor"))
    {
        return Some(SshError::AuthRequired {
            message: first,
            hint: AuthHint::KeyboardInteractive,
        });
    }
    if lower.contains("could not resolve hostname")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
    {
        return Some(SshError::CommandFailed { message: first });
    }
    if lower.contains("connection refused")
        || lower.contains("connection timed out")
        || lower.contains("no route to host")
        || lower.contains("network is unreachable")
    {
        return Some(SshError::CommandFailed { message: first });
    }
    None
}

pub fn classify_probe_output(stderr: &str) -> SshError {
    if let Some(err) = classify_stderr(stderr) {
        return err;
    }
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("keyboard-interactive") {
        return SshError::AuthRequired {
            message: stderr.lines().next().unwrap_or("keyboard-interactive auth required").trim().to_string(),
            hint: AuthHint::KeyboardInteractive,
        };
    }
    SshError::AuthRequired {
        message: stderr.lines().next().unwrap_or("ssh authentication required").trim().to_string(),
        hint: AuthHint::PasswordRequired,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_publickey_denial() {
        let err = classify_stderr("user@host: Permission denied (publickey,gssapi-keyex).");
        assert_eq!(
            err,
            Some(SshError::AuthRequired {
                message: "user@host: Permission denied (publickey,gssapi-keyex).".into(),
                hint: AuthHint::PublicKeyDenied,
            })
        );
    }

    #[test]
    fn classifies_password_retry() {
        let err = classify_stderr("Permission denied, please try again.");
        assert!(matches!(
            err,
            Some(SshError::AuthRequired {
                hint: AuthHint::PasswordRequired,
                ..
            })
        ));
    }

    #[test]
    fn classifies_host_key_failure() {
        let err = classify_stderr("Host key verification failed.");
        assert_eq!(
            err,
            Some(SshError::HostKey {
                message: "Host key verification failed.".into(),
                trusted: false,
            })
        );
    }

    #[test]
    fn classifies_unresolvable_host_as_command_failure() {
        let err = classify_stderr("ssh: Could not resolve hostname bogus: Name or service not known");
        assert!(matches!(err, Some(SshError::CommandFailed { .. })));
    }

    #[test]
    fn probe_falls_back_to_password_hint() {
        let err = classify_probe_output("some odd banner");
        assert!(matches!(
            err,
            SshError::AuthRequired {
                hint: AuthHint::PasswordRequired,
                ..
            }
        ));
    }
}
