use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

fn strip_inline_comment(line: &str) -> &str {
    let mut in_quote = false;
    let mut quote_char = '"';
    for (idx, ch) in line.char_indices() {
        if in_quote {
            if ch == quote_char {
                in_quote = false;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            in_quote = true;
            quote_char = ch;
            continue;
        }
        if ch == '#' {
            return line[..idx].trim_end();
        }
    }
    line
}

fn unquote(value: &str) -> String {
    let t = value.trim();
    if t.len() >= 2
        && ((t.starts_with('"') && t.ends_with('"'))
            || (t.starts_with('\'') && t.ends_with('\'')))
    {
        return t[1..t.len() - 1].to_string();
    }
    t.to_string()
}

fn is_wildcard(alias: &str) -> bool {
    alias.contains('*') || alias.contains('?') || alias.contains('!')
}

/// Read-only `~/.ssh/config` parser. First match wins per OpenSSH rules.
/// Wildcard `Host` stanzas and `Match` blocks are skipped: they describe
/// defaults, not connectable hosts.
pub fn parse_ssh_config(text: &str) -> Vec<ImportedHost> {
    let mut out: Vec<ImportedHost> = Vec::new();
    let mut current: Vec<ImportedHost> = Vec::new();
    let mut in_match = false;

    for raw in text.lines() {
        let line = strip_inline_comment(raw.trim()).trim().to_string();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, |c: char| c == ' ' || c == '\t' || c == '=');
        let keyword = parts.next().unwrap_or("").to_ascii_lowercase();
        let rest = parts.next().unwrap_or("").trim().to_string();
        match keyword.as_str() {
            "match" => {
                flush(&mut current, &mut out);
                in_match = true;
            }
            "host" => {
                flush(&mut current, &mut out);
                in_match = false;
                for raw_alias in rest.split_whitespace() {
                    let alias = unquote(raw_alias);
                    if alias.is_empty() || is_wildcard(&alias) {
                        continue;
                    }
                    current.push(ImportedHost {
                        alias,
                        ..Default::default()
                    });
                }
            }
            "hostname" if !in_match && !current.is_empty() => {
                let v = unquote(&rest);
                if !v.is_empty() {
                    for h in &mut current {
                        if h.hostname.is_none() {
                            h.hostname = Some(v.clone());
                        }
                    }
                }
            }
            "user" if !in_match && !current.is_empty() => {
                let v = unquote(&rest);
                if !v.is_empty() {
                    for h in &mut current {
                        if h.user.is_none() {
                            h.user = Some(v.clone());
                        }
                    }
                }
            }
            "port" if !in_match && !current.is_empty() => {
                if let Ok(p) = rest.split_whitespace().next().unwrap_or("").parse::<u16>() {
                    for h in &mut current {
                        if h.port.is_none() {
                            h.port = Some(p);
                        }
                    }
                }
            }
            "identityfile" if !in_match && !current.is_empty() => {
                let v = rest
                    .split_whitespace()
                    .next()
                    .map(unquote)
                    .unwrap_or_default();
                if !v.is_empty() {
                    for h in &mut current {
                        if h.identity_file.is_none() {
                            h.identity_file = Some(v.clone());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    flush(&mut current, &mut out);
    out.retain(|h| !h.alias.is_empty());
    out
}

fn flush(current: &mut Vec<ImportedHost>, out: &mut Vec<ImportedHost>) {
    if current.is_empty() {
        return;
    }
    for host in current.drain(..) {
        // OpenSSH semantics: the first obtained value wins per field, so a
        // later stanza for the same alias fills only fields still unset.
        if let Some(existing) = out.iter_mut().find(|h| h.alias == host.alias) {
            if existing.hostname.is_none() {
                existing.hostname = host.hostname;
            }
            if existing.user.is_none() {
                existing.user = host.user;
            }
            if existing.port.is_none() {
                existing.port = host.port;
            }
            if existing.identity_file.is_none() {
                existing.identity_file = host.identity_file;
            }
        } else {
            out.push(host);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_hosts() {
        let hosts = parse_ssh_config(
            "Host prod\n  HostName 10.0.0.5\n  User deploy\n  Port 2222\n",
        );
        assert_eq!(
            hosts,
            vec![ImportedHost {
                alias: "prod".into(),
                hostname: Some("10.0.0.5".into()),
                user: Some("deploy".into()),
                port: Some(2222),
                identity_file: None,
            }]
        );
    }

    #[test]
    fn skips_wildcards_and_match_blocks() {
        let hosts = parse_ssh_config(
            "Host *.internal\n  User svc\n\nHost db\n  HostName db.local\n\nMatch host web\n  Port 2022\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "db");
    }

    #[test]
    fn first_match_wins_for_repeated_alias() {
        let hosts = parse_ssh_config(
            "Host web\n  HostName a.example\n\nHost web\n  HostName b.example\n  User second\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname.as_deref(), Some("a.example"));
        assert_eq!(hosts[0].user.as_deref(), Some("second"));
    }

    #[test]
    fn handles_equals_syntax_comments_and_quotes() {
        let hosts = parse_ssh_config(
            "# comment\nHost=\"quoted\" # trailing\n  HostName = host.example # c\n  IdentityFile ~/.ssh/id_x # key\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "quoted");
        assert_eq!(hosts[0].identity_file.as_deref(), Some("~/.ssh/id_x"));
    }

    #[test]
    fn multiple_aliases_share_settings() {
        let hosts = parse_ssh_config("Host a b\n  User u\n  Port 2200\n");
        assert_eq!(hosts.len(), 2);
        assert!(hosts.iter().all(|h| h.user.as_deref() == Some("u")));
    }
}
