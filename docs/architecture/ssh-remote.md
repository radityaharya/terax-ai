# SSH remote workspaces

This guide elaborates on `TERAX.md`. If anything here conflicts with `TERAX.md`, `TERAX.md` wins.

Terax connects to Linux servers over system `ssh` with two channels: an
interactive PTY (`ssh -t`) and an RPC side-channel (`terax-remote serve` over
stdio). The desktop never links SSH/crypto crates; transport is the `ssh`
binary, the same way git and WSL shell out today.

## Channels

- **Interactive PTY**: `pty_open` with `WorkspaceEnv::Ssh` builds
  `ssh -t -o StrictHostKeyChecking=yes user@host <remote shell>` inside
  `portable-pty` (`pty/shell_init.rs: build_ssh`). Passwords and 2FA
  complete natively in the PTY. No shell integration yet: tabs run bare
  (no OSC 7/133) until the agent installs integration scripts.
- **RPC side-channel**: `SshRpcManager` (`ssh/rpc.rs`) holds one stdio
  `ssh -T host terax-remote serve --root <dir> --token <hex>` child per
  host. Requests are newline-delimited JSON (protocol v2, additive over the
  local control protocol), multiplexed by id under a single lock. The
  `ssh_rpc` Tauri command allow-lists methods; anything else is rejected.

## The agent

`crates/terax-remote` is a static Linux binary built from `terax-core`
(the same fs/git/shell logic the desktop uses). It binds nothing: stdio
only, loopback by construction since it runs as the ssh child.

- Auth: per-connection 64-hex token over stdin args, constant-time
  compared. `--root` is canonicalized and every path is checked against
  it before dispatch.
- Distribution: bundled under `src-tauri/binaries/terax-remote-<target>`
  (`pnpm build:remote`, cross-compile with `TERAX_REMOTE_TARGET`), uploaded
  on first connect via stdin redirect + `chmod +x`, version-checked on
  every connect, refused on mismatch.
- Methods: `fs_*` (read_dir/read_file/write_file/stat/search/grep,
  create/rename/delete/delete_batch/move/copy), `git_*` (panel/status/
  resolve/diff/diff_content/stage/unstage/discard/commit/log/show/
  files/file_diff/remote_url/fetch/pull/push/branches/checkout),
  `shell_run`, `shell_session_*`, `shell_bg_*`.

## Hosts

- `SshHost { id, alias, user, hostname, port, identityFile?, remoteRoot?,
  boundSpaceId?, agentForward }` lives in the frontend host store;
  `ssh_*` commands (`ssh/list_hosts/save/delete/test/import/...`) manage
  probing and known_hosts. Secrets (passwords, key passphrases) live in
  the OS keychain as `ssh:<host-id>`, never in the host store.
- `~/.ssh/config` imports as a live read-only reference; managed hosts
  override on alias conflict. Terax never writes the file.
- `known_hosts`: `StrictHostKeyChecking=yes` always. Unknown keys show the
  TOFU dialog with `ssh-keyscan` fingerprints; the user verifies out of
  band. Mismatches hard-block like git's `HostKeyUnverified`.
- Auth order: master check, BatchMode probe (keys/agent), classified
  fallback (key file, password via askpass helper, or 2FA in a terminal
  tab). The RPC channel always runs `BatchMode=yes` and multiplexes over
  the established master; interactive auth never happens on it.
- Askpass: one-shot 0700 script + 0600 secret file in a 0700 temp dir,
  deleted after use (plus a 120s expiry thread). Secrets never appear in
  argv, env, logs, or IPC traces.

## UI

- Hosts is the third sidebar rail tab (`Files / Git / Hosts`), with
  status dots, search filter, managed + imported sections, and hover
  actions. Clicking a host probes (host-key, then auth) and jumps to its
  bound space, creating and binding one on first connect.
- Spaces auto-bind one space per host; tabs persist per host and restore
  on jump. One active host at a time (single global `WorkspaceEnv`).
  Background hosts stay connected until a 10-minute idle timeout drops
  the RPC channel; PTY tabs stay open with reconnect.
- Remote OSC 7 paths never enter the local workspace registry
  (`handleTerminalCwd` skips SSH; `authorize_*` rejects SSH). The local
  registry only ever holds local paths.

## Invariants

- Every local `#[tauri::command]` calls `require_local_workspace` before
  touching the FS. SSH paths are opaque strings until the agent serves them.
- `security.ts` runs locally as a pre-filter; the agent enforces its own
  registry + deny-list server-side with the remote home.
- `ssh_rpc` method allow-list is the only remote entry point. No shell
  metacharacters cross it: paths are data, commands run through the
  agent's existing argument vectors.
- LSP stays disabled for SSH (like WSL). Port forwarding UI, SFTP-only
  mode, and tunnel transports are out of scope for v1.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [Security model](security-model.md) - boundaries and invariants
- [Two-process model](two-process-model.md) - IPC boundary
