# Docker management

This guide elaborates on `TERAX.md`. If anything here conflicts with `TERAX.md`, `TERAX.md` wins.

Terax manages Docker on SSH hosts through the existing `terax-remote` RPC
channel — no new transport, no Docker Engine API client, no new crates.
v1 is SSH-hosts-only; the Docker panel is host-scoped to the active tab.
Local/WSL Docker contexts land in a later milestone.

## Protocol

All `docker_*` method names live in
`crates/terax-control-protocol/src/lib.rs` as `REMOTE_METHOD_*` consts and
are members of the single `REMOTE_METHODS` registry. The `ssh_rpc` Tauri
command rejects anything not in that registry before touching the
network — there is no second manual allow-list to drift.

`docker exec` / `docker attach` are **not** RPC methods. They are PTY
spawn specs (`DockerExecSpec` in `pty/shell_init.rs: build_docker_exec`,
sibling to `build_ssh`): `ssh -t user@host docker exec -it <container>
<shell>`. Container ids are validated against the identifier grammar and
shells come from the fixed allow-list in
`terax-core/src/docker/containers.rs`; anything else is rejected before
spawn. Exec tabs carry `TerminalTab.dockerExec` identity (title
`name@exec`, container icon, serialize/restore, reconnect via the panel).

## Agent routes

`crates/terax-remote/src/docker.rs` holds every `docker_*` route handler;
`main.rs` does thin dispatch only (`docker_` prefix → module).
`DockerShared` agent state tracks log/event background handles and a
capabilities cache (60s TTL).

Capabilities / disk / stats:
`docker_capabilities` (version, compose v2/v1, swarm state, server
version, rootless/socket, context), `docker_system_df`,
`docker_stats`, `docker_events_spawn/poll/kill`.

Containers: `docker_ps`, `docker_inspect` (kind+id validated),
`docker_start/stop/restart/kill/rm`, `docker_prune` (enumerated target),
`docker_container_shell_probe`, `docker_cp_to` (M2 adds `cp_from`).

Images / registry: `docker_images`, `docker_pull` (bg proc, per-layer
progress events + quiet mode), `docker_rmi`, `docker_image_update_check`
(local RepoDigest vs `manifest inspect`), `docker_image_tag/push/
history`, `docker_build` (M2), `docker_registry_login/logout/list`.

Volumes / networks: `docker_volumes_ls`, `docker_volume_rm`,
`docker_networks_ls`, `docker_network_rm`.

Logs: `docker_logs_spawn/poll/kill` over the ring-buffer bg procs.

Compose: `docker_compose_detect` (filename scan under the authorized
root), `ps/config/up/down/restart/pull/logs/build` — all paths pass the
agent's `authorized()` gate.

Swarm / service / stack: `docker_swarm_info`, `docker_node_ls/update/
promote/demote`, `docker_swarm_init/join/leave`, `docker_service_ls/
inspect/ps/scale/update/rm/rollback/logs`, `docker_stack_ls/services/
ps/deploy/rm`.

Swarm secrets / configs: `docker_secret_ls/create/rm`,
`docker_config_ls/create/rm`.

## Frontend

`src/modules/docker/`: zustand `dockerStore` (per-host daemon state +
resource lists, capabilities-first `refreshAll`), `DockerPanel` with
filter + segmented views + hover actions + status dots, `DetailsDrawer`
(structured inspect, copy, health/restart/exit chips), `CleanupHub`
(`system df` + per-category prune + reclaim confirm), `DockerLogsPane`
(follow, timestamps, tail, since, wrap, ANSI→spans, regex
filter/highlight, export), `DockerEventsPane` + headless
`DockerNotifications` (died/unhealthy/OOM/update/under-replicated,
per-host mute, jump-on-click), `ComposeCard` project grouping,
`SwarmPanel` (nodes/services/stacks, replica mismatch) +
`SwarmSecretsPanel` + `SwarmInitPrompt`.

Shell builders + output parsers live in `terax-core/src/docker/`
(unit-testable without SSH): capabilities probe, container argv +
validators, pull-progress parser, digest compare, compose prefix/files,
swarm replicas/drift, stats + system-df parsers.

AI tools (`src/modules/ai/tools/docker.ts`): `docker_ps/images/
inspect/logs` auto-execute; `pull/lifecycle` need approval; `docker_
diagnose` bundles inspect+logs+exit code into an RCA summary. Palette
has a Docker group; the new-tab menu lists per-host exec entries;
`docker-logs` is a serializable tab kind.

## Security

The Docker surface follows the SSH security model
(`security-model.md`, `ssh-remote.md`):

- The frontend sends structured params only; the agent builds every
  `docker` argv. Identifiers match `[A-Za-z0-9][A-Za-z0-9_.\-:/@]*`;
  shells come from the fixed allow-list; prune targets are enumerated;
  `service update` supports `--image` only (bounded surface).
- Path-scoped ops (`compose_*`, `stack deploy`, `cp`, `build`, config
  create-from-file) pass the agent's `authorized()` gate against the
  connection root. Document socket = host root.
- Registry passwords, swarm join tokens, and swarm secret values travel
  the token-authenticated RPC channel only, feed `docker login
  --password-stdin` / `swarm join --token` / `secret create -` stdin
  server-side, and are never logged. Registry credentials persist in the
  OS keyring scoped `docker-registry:<host-id>:<registry>`; the host
  store and docker store hold login state only, never credentials.
- `docker exec` tabs report container-internal cwds via OSC 7; the
  frontend records them on the leaf for display but never lets them
  drive the explorer root or the auth registry.
- Env values rendered from inspect output mask `*pass*/*secret*/*token*/
  *key*` vars in the UI.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [SSH remote workspaces](ssh-remote.md) - transport and agent model
- [Security model](security-model.md) - boundaries and invariants
