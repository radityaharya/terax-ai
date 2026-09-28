# Iroh P2P fallback

This guide elaborates on `TERAX.md` and `docs/architecture/ssh-remote.md`.
If anything here conflicts, `TERAX.md` wins.

SSH remains the only first-contact channel for a host. This adds an optional
peer-to-peer fallback transport (via [iroh](https://iroh.computer)) so an
already-paired host keeps answering `ssh_rpc` calls even when SSH itself
becomes unreachable (network roamed, NAT changed, SSH port blocked) while the
remote process is still alive. Nothing here replaces SSH: pairing, the agent
binary, and the allow-listed method surface are all identical to
`ssh-remote.md`; only the pipe changes.

## Pairing (SSH-bootstrapped, TOFU-style)

There is no account, no Terax-operated backend, and no lookup service. A
host's iroh identity (`EndpointId`, an Ed25519 public key) is only ever
learned once, over an already-open SSH connection, and pinned by the desktop
itself - the same trust-on-first-use shape as SSH host keys, except Terax
owns the pin instead of the `ssh` binary writing `~/.ssh/known_hosts`:

1. `iroh_setup_host` (`src-tauri/src/modules/iroh_fallback/commands.rs`)
   drives the existing SSH RPC channel (`ssh_rpc_call`) to call the new
   `iroh_bootstrap` remote method. The agent (still running as the SSH
   child) generates or loads a persistent identity and a fallback token
   under `~/.cache/terax/`, and ensures a detached `terax-remote iroh-serve`
   daemon is running for the host's root.
2. The returned `EndpointId` and token come back to the desktop. The token
   is stored in the OS keychain (`secrets_*`, service `terax-iroh`, account
   = host id) immediately. The `EndpointId` is **not** pinned yet.
3. `IrohPairDialog.tsx` shows the endpoint id's fingerprint (mirrors
   `HostKeyDialog.tsx`). Only after explicit user confirmation does
   `iroh_confirm_pin` write `SshHost.irohEndpointId`.

A host with no `irohEndpointId` never attempts an iroh fallback: the
overwhelming majority of hosts pay zero cost for this feature.

## The agent daemon

`terax-remote iroh-serve --root <dir>` (`src-tauri/crates/terax-remote/src/iroh_fallback.rs`)
is a small addition to the same binary the SSH RPC channel already uploads -
no separate artifact, no new upload/version-check path.

- **Persistence**: identity (`iroh-identity`) and fallback token
  (`terax-iroh-token`) live under `~/.cache/terax/`, 0600, generated once and
  reused across restarts so a pinned `EndpointId` keeps resolving to the same
  host.
- **Daemonizing**: `iroh_bootstrap` spawns a fresh child process
  (`Command::new(current_exe())`) that calls `setsid()` in `pre_exec` before
  exec'ing into `iroh-serve --foreground`, detaching it from the SSH
  session's process group. This runs in a freshly spawned process, never in
  the already-multithreaded `Agent` process, since forking a threaded
  process is unsafe. A pidfile (`terax-iroh.pid`) backs a liveness check
  (`kill(pid, 0)`) so re-bootstrapping an already-armed host is a no-op.
- **No systemd, no reboot survival.** If the host reboots or the daemon
  crashes, the iroh fallback silently stops protecting that host until the
  next successful SSH connect re-arms it via `iroh_bootstrap`. This is a
  deliberate, scoped v1 limitation - not an oversight.
- **Runtime**: a small dedicated tokio runtime (`rt-multi-thread`, 2
  workers) binds one iroh `Endpoint` and answers one QUIC bidi stream per
  request, delegating to the exact same `Agent::handle_line` the SSH stdio
  loop uses. No new request-routing logic, no new method surface.

## Wire shape

The iroh transport reuses the SSH RPC pipe's `ControlRequest`/
`ControlResponse` JSON envelope (`terax-control-protocol`) unchanged, with
one difference in framing: instead of a long-lived multiplexed pipe with
id-based dispatch, each logical request gets its own QUIC bidi stream
(`IROH_ALPN = "terax-remote/iroh/1"`) - open, write one JSON line, finish;
read one JSON line, done. Opening a stream on an already-connected iroh
`Connection` is cheap enough that a dispatch table buys nothing here, unlike
the SSH pipe where a full `ssh` handshake per request would be prohibitive
(see `ssh-remote.md`'s Win32-OpenSSH multiplexing note).

## Authentication

Two independent gates, both already-existing mechanisms, layered:

1. **Cryptographic**: iroh's QUIC/TLS handshake authenticates the peer's
   `EndpointId` before any application data flows - this is inherent to
   iroh, not something Terax adds. The desktop only ever dials the pinned
   `EndpointId`; a peer presenting a different key fails the connection
   before the first stream opens.
2. **Bearer token**: the same `ControlRequest.token` field and
   constant-time-compare (`terax-remote::auth`) the SSH RPC channel already
   uses, just with a *different, persistent* token (the SSH channel's token
   is per-connection and ephemeral; the iroh daemon's is generated once and
   reused across restarts, since there is no fresh SSH handshake to mint a
   new one from each time).

## Relay and transport config

Config is global (not per-host), set in **Settings > Iroh**, and applied to
each host on its next pairing/bootstrap. Two independent fields:

- **Relay endpoints** (non-secret, `terax-iroh.json` under the app data
  dir): custom relay URLs, one per line. Empty uses the mode default.
- **n0 Iroh Services API key** (secret, OS keychain under service
  `terax-iroh`, account `n0-api-key`): enables n0's authenticated
  shared/dedicated relays. The key is used locally to mint an
  endpoint-bound relay token; it is never sent to the relay.

Both the desktop and the agent select a mode from that config, in priority
order (`build_endpoint` in `terax-remote::iroh_fallback`, mirrored in
`modules/iroh_fallback/rpc.rs`):

1. **API key set** -> `iroh_services::preset()`, optionally with explicit
   relay URLs for a dedicated deployment.
2. **Custom relays, no API key** -> plain `iroh` with `RelayMode::custom`
   and address lookup disabled, so a self-hosted deployment never contacts
   n0's DNS. The desktop then dials the relay addresses explicitly rather
   than looking them up by `EndpointId`.
3. **Nothing configured** -> `presets::N0`: free public relays plus n0 DNS
   address lookup (the zero-config default).

The desktop pushes both fields to the agent over the already-authenticated
SSH channel during `iroh_bootstrap`; the agent writes them 0600 under
`~/.cache/terax/` and restarts its daemon if they changed. Supplying the
fields is tri-state: absent leaves the remote config untouched, present
(even empty) rewrites it.

No relay is a Terax-operated dependency: with (2) nothing in the fallback
path touches n0 at all.

## Fallback path

`ssh_rpc` (`src-tauri/src/modules/ssh/commands.rs`) tries SSH first, always.
On any SSH failure, it checks whether the host has `irohEndpointId` set; if
not, the original SSH error returns immediately - no wasted dial attempt for
the common case. If armed, it retries the exact same allow-listed method
over `IrohRpcManager` (`src-tauri/src/modules/iroh_fallback/rpc.rs`) using
the pinned `EndpointId` and stored token. If iroh also fails, the original
SSH error is returned (usually the more actionable one for the user), not
the iroh dial failure.

`ssh_disconnect` drops both transports' live connections for a host.

## Invariants

- The `REMOTE_METHODS` allow-list (`terax-control-protocol`) is the single
  gate for both transports - `ssh_rpc_call` and `iroh_rpc_call` both check
  it, and neither bypasses the other.
- A host's iroh fallback requires an explicit, confirmed pin
  (`iroh_confirm_pin`). No implicit trust, no lookup-based discovery.
- The agent binds a network listener only when a host has explicitly
  bootstrapped the iroh daemon. Before that, `terax-remote` is exactly as
  described in `ssh-remote.md`: stdio only, binds nothing.
- `iroh_disable` clears the pin and stored token and drops the live
  connection; it does not reach out to stop the remote daemon (no channel
  guaranteed to still exist), so a disabled host's daemon keeps running
  but answers only requests bearing its still-valid token - harmless, since
  nothing on the desktop retains that token once `iroh_disable` completes.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [SSH remote workspaces](ssh-remote.md) - the primary transport this
  fallback rides on top of
- [Security model](security-model.md) - boundaries and invariants
