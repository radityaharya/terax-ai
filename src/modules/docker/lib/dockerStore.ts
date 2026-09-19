import { sshRpc } from "@/modules/ai/lib/native";
import { create } from "zustand";
import type {
  DockerCapabilities,
  DockerContainer,
  DockerDaemonState,
  DockerImage,
  DockerNetwork,
  DockerVolume,
  ResourceListState,
} from "./types";

function emptyList<T>(): ResourceListState<T> {
  return { items: [], loading: false, error: null, updatedAt: null };
}

export type ContainerAction =
  | "start"
  | "stop"
  | "restart"
  | "kill"
  | "remove";

export type StatsSample = {
  container: string;
  name: string;
  cpuPerc: string;
  memUsage: string;
  memPerc: string;
  netIO: string;
  blockIO: string;
  pids: string;
};

export type DiskUsage = {
  imagesSize: string;
  imagesReclaimable: string;
  containersSize: string;
  containersReclaimable: string;
  volumesSize: string;
  volumesReclaimable: string;
  buildCacheSize: string;
  buildCacheReclaimable: string;
};

export type PruneTarget = "containers" | "images" | "volumes" | "networks" | "builder" | "system";

type HostDockerState = {
  daemon: DockerDaemonState;
  containers: ResourceListState<DockerContainer>;
  images: ResourceListState<DockerImage>;
  volumes: ResourceListState<DockerVolume>;
  networks: ResourceListState<DockerNetwork>;
  /** Container ids with a lifecycle action in flight. */
  busyContainers: Record<string, ContainerAction>;
  /** Last polled `docker stats` samples keyed by container id. */
  stats: Record<string, StatsSample>;
  statsAt: number | null;
  statsError: string | null;
  /** `docker system df` snapshot for the cleanup hub. */
  disk: DiskUsage | null;
  diskLoading: boolean;
  diskError: string | null;
  /** Prune op in flight (target key). */
  pruning: PruneTarget | null;
  pruneOutput: string | null;
  /** Image ids with an op in flight (pull/tag/push/rmi). */
  busyImages: Record<string, string>;
  /** Update-check results keyed by image reference. */
  updates: Record<string, ImageUpdateState>;
  /** Registry login state per registry host. */
  registries: Record<string, { loggedIn: boolean; busy: boolean; error: string | null }>;
  /** Pull jobs keyed by local job id. */
  pulls: Record<string, PullJob>;
  /** Live log follows keyed by `container:<id>` or `service:<id>`. */
  logFollows: Record<string, LogFollowState>;
  /** `docker events` stream (one per host). */
  eventsFeed: EventsFeedState | null;
  /** Muted notification rule kinds per host. */
  notifyMute: Record<string, boolean>;
};

export type ImageUpdateState =
  | { status: "unknown" | "checking" }
  | { status: "current"; localDigest: string }
  | { status: "available"; localDigest: string }
  | { status: "error"; message: string };

export type PullJob = {
  reference: string;
  platform: string;
  quiet: boolean;
  /** Agent bg handle once spawned. */
  handle: number | null;
  phase: "starting" | "pulling" | "done" | "error";
  /** Raw ring-buffer text (fallback view). */
  output: string;
  offset: number;
  dropped: number;
  events: import("./types").PullProgressEvent[];
  digest: string | null;
  error: string | null;
};

export type LogViewOptions = {
  timestamps: boolean;
  tail: number;
  since: string;
};

export type LogFollowState = {
  /** Agent bg handle for `docker logs -f`. */
  handle: number | null;
  phase: "starting" | "following" | "done" | "error";
  lines: string[];
  offset: number;
  dropped: number;
  exited: boolean;
  exitCode: number | null;
  error: string | null;
  options: LogViewOptions;
};

export type DockerEvent = {
  Type?: string;
  Action?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  time?: number;
  timeNano?: number;
  [key: string]: unknown;
};

export type EventsFeedState = {
  /** Agent bg handle for `docker events --format json`. */
  handle: number | null;
  phase: "starting" | "streaming" | "done" | "error";
  events: DockerEvent[];
  offset: number;
  dropped: number;
  error: string | null;
};

export type NotifyRule =
  | { kind: "died"; enabled: boolean }
  | { kind: "unhealthy"; enabled: boolean }
  | { kind: "oom"; enabled: boolean }
  | { kind: "update"; enabled: boolean }
  | { kind: "underReplicated"; enabled: boolean };

export type NotifyMute = {
  /** hostId -> muted rule kinds. Absent = all rules on. */
  byHost: Record<string, string[]>;
};

function emptyHost(): HostDockerState {
  return {
    daemon: { status: "unknown" },
    containers: emptyList(),
    images: emptyList(),
    volumes: emptyList(),
    networks: emptyList(),
    busyContainers: {},
    stats: {},
    statsAt: null,
    statsError: null,
    disk: null,
    diskLoading: false,
    diskError: null,
    pruning: null,
    pruneOutput: null,
    busyImages: {},
    updates: {},
    registries: {},
    pulls: {},
    logFollows: {},
    eventsFeed: null,
    notifyMute: {},
  };
}

const ALL_RULES = ["died", "unhealthy", "oom", "update", "underReplicated"];

export type InspectState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: unknown }
  | { status: "error"; message: string };

type State = {
  byHost: Record<string, HostDockerState>;
  /** hostId -> "kind:id" -> inspect state. */
  inspects: Record<string, InspectState>;
  refreshCapabilities: (hostId: string) => Promise<void>;
  refreshContainers: (hostId: string, all?: boolean) => Promise<void>;
  refreshImages: (hostId: string) => Promise<void>;
  refreshVolumes: (hostId: string) => Promise<void>;
  refreshNetworks: (hostId: string) => Promise<void>;
  refreshAll: (hostId: string) => Promise<void>;
  containerAction: (
    hostId: string,
    action: ContainerAction,
    ids: string[],
    opts?: { force?: boolean; timeout?: number },
  ) => Promise<void>;
  refreshStats: (hostId: string, ids?: string[]) => Promise<void>;
  fetchInspect: (
    hostId: string,
    kind: "container" | "image" | "volume" | "network" | "service",
    id: string,
  ) => Promise<void>;
  clearInspect: (hostId: string, kind: string, id: string) => void;
  refreshDisk: (hostId: string) => Promise<void>;
  prune: (
    hostId: string,
    target: PruneTarget,
    opts?: { all?: boolean; volumes?: boolean },
  ) => Promise<void>;
  clearPruneOutput: (hostId: string) => void;
  removeImage: (hostId: string, id: string, force?: boolean) => Promise<void>;
  checkUpdate: (hostId: string, reference: string) => Promise<void>;
  startPull: (
    hostId: string,
    reference: string,
    opts?: { platform?: string; quiet?: boolean },
  ) => string;
  pollPull: (hostId: string, jobId: string) => Promise<void>;
  cancelPull: (hostId: string, jobId: string) => Promise<void>;
  dismissPull: (hostId: string, jobId: string) => void;
  registryLogin: (
    hostId: string,
    registry: string,
    username: string,
    password: string,
  ) => Promise<void>;
  registryLogout: (hostId: string, registry: string) => Promise<void>;
  startLogFollow: (
    hostId: string,
    kind: "container" | "service",
    id: string,
    options?: Partial<LogViewOptions>,
  ) => string;
  pollLogFollow: (hostId: string, followId: string) => Promise<void>;
  stopLogFollow: (hostId: string, followId: string) => Promise<void>;
  setLogOptions: (
    hostId: string,
    followId: string,
    options: Partial<LogViewOptions>,
  ) => void;
  startEventsFeed: (hostId: string, filter?: string) => Promise<void>;
  pollEventsFeed: (hostId: string) => Promise<void>;
  stopEventsFeed: (hostId: string) => Promise<void>;
  setRuleMuted: (hostId: string, rule: string, muted: boolean) => void;
  isRuleMuted: (hostId: string, rule: string) => boolean;
};

function patch(
  set: (f: (s: State) => State) => void,
  hostId: string,
  f: (h: HostDockerState) => HostDockerState,
) {
  set((s: State) => ({
    ...s,
    byHost: { ...s.byHost, [hostId]: f(s.byHost[hostId] ?? emptyHost()) },
  }));
}

function classifyDaemonError(e: unknown): DockerDaemonState {
  const msg = String(e);
  if (msg.includes("docker_permission")) {
    return { status: "permission-denied", message: msg };
  }
  if (
    msg.includes("docker_daemon_down") ||
    msg.includes("Cannot connect to the Docker daemon") ||
    msg.includes("Is the docker daemon running")
  ) {
    return { status: "daemon-down", message: msg };
  }
  if (
    msg.includes("not found") ||
    msg.includes("No such file") ||
    msg.includes("command not found")
  ) {
    return { status: "not-installed", message: msg };
  }
  return { status: "offline", message: msg };
}

export function inspectKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export const useDockerStore = create<State>((set) => ({
  byHost: {},
  inspects: {},

  refreshCapabilities: async (hostId: string) => {
    patch(set, hostId, (h) => ({ ...h, daemon: { status: "checking" } }));
    try {
      const caps = await sshRpc<DockerCapabilities>(
        "docker_capabilities",
        {},
        hostId,
      );
      if (!caps.installed) {
        patch(set, hostId, (h) => ({
          ...h,
          daemon: { status: "not-installed", message: "Docker is not installed on this host." },
        }));
        return;
      }
      if (!caps.daemonRunning) {
        patch(set, hostId, (h) => ({
          ...h,
          daemon: { status: "daemon-down", message: "Docker daemon is not running." },
        }));
        return;
      }
      if (caps.permissionDenied) {
        patch(set, hostId, (h) => ({
          ...h,
          daemon: {
            status: "permission-denied",
            message: "Permission denied talking to the Docker socket.",
          },
        }));
        return;
      }
      patch(set, hostId, (h) => ({
        ...h,
        daemon: { status: "ready", capabilities: caps },
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({ ...h, daemon: classifyDaemonError(e) }));
    }
  },

  refreshContainers: async (hostId: string, all = true) => {
    patch(set, hostId, (h) => ({
      ...h,
      containers: { ...h.containers, loading: true, error: null },
    }));
    try {
      const items = await sshRpc<DockerContainer[]>("docker_ps", { all }, hostId);
      patch(set, hostId, (h) => ({
        ...h,
        containers: { items, loading: false, error: null, updatedAt: Date.now() },
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        containers: { ...h.containers, loading: false, error: String(e) },
      }));
    }
  },

  refreshImages: async (hostId: string) => {
    patch(set, hostId, (h) => ({
      ...h,
      images: { ...h.images, loading: true, error: null },
    }));
    try {
      const items = await sshRpc<DockerImage[]>("docker_images", {}, hostId);
      patch(set, hostId, (h) => ({
        ...h,
        images: { items, loading: false, error: null, updatedAt: Date.now() },
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        images: { ...h.images, loading: false, error: String(e) },
      }));
    }
  },

  refreshVolumes: async (hostId: string) => {
    patch(set, hostId, (h) => ({
      ...h,
      volumes: { ...h.volumes, loading: true, error: null },
    }));
    try {
      const items = await sshRpc<DockerVolume[]>("docker_volumes_ls", {}, hostId);
      patch(set, hostId, (h) => ({
        ...h,
        volumes: { items, loading: false, error: null, updatedAt: Date.now() },
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        volumes: { ...h.volumes, loading: false, error: String(e) },
      }));
    }
  },

  refreshNetworks: async (hostId: string) => {
    patch(set, hostId, (h) => ({
      ...h,
      networks: { ...h.networks, loading: true, error: null },
    }));
    try {
      const items = await sshRpc<DockerNetwork[]>("docker_networks_ls", {}, hostId);
      patch(set, hostId, (h) => ({
        ...h,
        networks: { items, loading: false, error: null, updatedAt: Date.now() },
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        networks: { ...h.networks, loading: false, error: String(e) },
      }));
    }
  },

  refreshAll: async (hostId: string) => {
    const s = useDockerStore.getState();
    await s.refreshCapabilities(hostId);
    const daemon = useDockerStore.getState().byHost[hostId]?.daemon;
    if (daemon?.status !== "ready") return;
    await Promise.all([
      s.refreshContainers(hostId),
      s.refreshImages(hostId),
      s.refreshVolumes(hostId),
      s.refreshNetworks(hostId),
    ]);
  },

  containerAction: async (hostId, action, ids, opts) => {
    if (ids.length === 0) return;
    patch(set, hostId, (h) => ({
      ...h,
      busyContainers: {
        ...h.busyContainers,
        ...Object.fromEntries(ids.map((id) => [id, action])),
      },
    }));
    try {
      const method =
        action === "remove" ? "docker_rm" : `docker_${action}`;
      await sshRpc<string>(
        method,
        {
          ids,
          ...(action === "remove" && opts?.force ? { force: true } : {}),
          ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
        },
        hostId,
      );
      await useDockerStore.getState().refreshContainers(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        containers: { ...h.containers, error: String(e) },
      }));
    } finally {
      patch(set, hostId, (h) => {
        const busy = { ...h.busyContainers };
        for (const id of ids) delete busy[id];
        return { ...h, busyContainers: busy };
      });
    }
  },

  refreshStats: async (hostId, ids) => {
    try {
      const samples = await sshRpc<StatsSample[]>(
        "docker_stats",
        ids && ids.length > 0 ? { ids } : {},
        hostId,
      );
      patch(set, hostId, (h) => ({
        ...h,
        stats: Object.fromEntries(
          samples.map((s) => [s.container || s.name, s]),
        ),
        statsAt: Date.now(),
        statsError: null,
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({ ...h, statsError: String(e) }));
    }
  },

  fetchInspect: async (hostId, kind, id) => {
    const key = `${hostId}\u0000${inspectKey(kind, id)}`;
    set((s) => ({
      ...s,
      inspects: { ...s.inspects, [key]: { status: "loading" } },
    }));
    try {
      const data = await sshRpc<unknown>("docker_inspect", { kind, id }, hostId);
      set((s) => ({
        ...s,
        inspects: { ...s.inspects, [key]: { status: "ready", data } },
      }));
    } catch (e) {
      set((s) => ({
        ...s,
        inspects: {
          ...s.inspects,
          [key]: { status: "error", message: String(e) },
        },
      }));
    }
  },

  clearInspect: (hostId, kind, id) => {
    const key = `${hostId}\u0000${inspectKey(kind, id)}`;
    set((s) => {
      if (!(key in s.inspects)) return s;
      const next = { ...s.inspects };
      delete next[key];
      return { ...s, inspects: next };
    });
  },

  refreshDisk: async (hostId) => {
    patch(set, hostId, (h) => ({ ...h, diskLoading: true, diskError: null }));
    try {
      const disk = await sshRpc<DiskUsage>("docker_system_df", {}, hostId);
      patch(set, hostId, (h) => ({
        ...h,
        disk,
        diskLoading: false,
        diskError: null,
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        diskLoading: false,
        diskError: String(e),
      }));
    }
  },

  prune: async (hostId, target, opts) => {
    patch(set, hostId, (h) => ({ ...h, pruning: target, pruneOutput: null }));
    try {
      const output = await sshRpc<string>(
        "docker_prune",
        {
          target,
          ...(opts?.all ? { all: true } : {}),
          ...(opts?.volumes ? { volumes: true } : {}),
        },
        hostId,
      );
      patch(set, hostId, (h) => ({
        ...h,
        pruning: null,
        pruneOutput: String(output ?? "Done."),
      }));
      // Fresh numbers after any prune.
      await useDockerStore.getState().refreshDisk(hostId);
      await useDockerStore.getState().refreshContainers(hostId);
      await useDockerStore.getState().refreshImages(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        pruning: null,
        pruneOutput: `Failed: ${String(e)}`,
      }));
    }
  },

  clearPruneOutput: (hostId) => {
    patch(set, hostId, (h) => ({ ...h, pruneOutput: null }));
  },

  removeImage: async (hostId, id, force) => {
    patch(set, hostId, (h) => ({
      ...h,
      busyImages: { ...h.busyImages, [id]: "removing" },
    }));
    try {
      await sshRpc<string>(
        "docker_rmi",
        { ids: [id], ...(force ? { force: true } : {}) },
        hostId,
      );
      await useDockerStore.getState().refreshImages(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        images: { ...h.images, error: String(e) },
      }));
    } finally {
      patch(set, hostId, (h) => {
        const busy = { ...h.busyImages };
        delete busy[id];
        return { ...h, busyImages: busy };
      });
    }
  },

  checkUpdate: async (hostId, reference) => {
    patch(set, hostId, (h) => ({
      ...h,
      updates: { ...h.updates, [reference]: { status: "checking" } },
    }));
    try {
      const res = await sshRpc<{
        reference: string;
        localDigest: string;
        updateAvailable: boolean;
      }>("docker_image_update_check", { reference }, hostId);
      patch(set, hostId, (h) => ({
        ...h,
        updates: {
          ...h.updates,
          [reference]: res.updateAvailable
            ? { status: "available", localDigest: res.localDigest }
            : { status: "current", localDigest: res.localDigest },
        },
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        updates: {
          ...h.updates,
          [reference]: { status: "error", message: String(e) },
        },
      }));
    }
  },

  startPull: (hostId, reference, opts) => {
    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job: PullJob = {
      reference,
      platform: opts?.platform ?? "",
      quiet: opts?.quiet ?? false,
      handle: null,
      phase: "starting",
      output: "",
      offset: 0,
      dropped: 0,
      events: [],
      digest: null,
      error: null,
    };
    patch(set, hostId, (h) => ({
      ...h,
      pulls: { ...h.pulls, [jobId]: job },
    }));
    void (async () => {
      try {
        const info = await sshRpc<{ handle: number }>(
          "docker_pull",
          {
            reference,
            ...(opts?.platform ? { platform: opts.platform } : {}),
            ...(opts?.quiet ? { quiet: true } : {}),
          },
          hostId,
        );
        patch(set, hostId, (h) => ({
          ...h,
          pulls: {
            ...h.pulls,
            [jobId]: { ...(h.pulls[jobId] ?? job), handle: info.handle, phase: "pulling" },
          },
        }));
        await useDockerStore.getState().pollPull(hostId, jobId);
      } catch (e) {
        patch(set, hostId, (h) => ({
          ...h,
          pulls: {
            ...h.pulls,
            [jobId]: { ...(h.pulls[jobId] ?? job), phase: "error", error: String(e) },
          },
        }));
      }
    })();
    return jobId;
  },

  pollPull: async (hostId, jobId) => {
    const job = useDockerStore.getState().byHost[hostId]?.pulls[jobId];
    if (!job || job.handle === null || job.phase === "done" || job.phase === "error") return;
    try {
      const res = await sshRpc<{
        bytes: string;
        next_offset: number;
        dropped: number;
        exited: boolean;
        exit_code: number | null;
        events?: import("./types").PullProgressEvent[];
      }>("docker_logs_poll", { handle: job.handle, sinceOffset: job.offset }, hostId);
      patch(set, hostId, (h) => {
        const cur = h.pulls[jobId] ?? job;
        const next: PullJob = {
          ...cur,
          output: cur.output + (res.bytes ?? ""),
          offset: res.next_offset ?? cur.offset,
          dropped: (res.dropped ?? 0) > cur.dropped ? (res.dropped ?? 0) : cur.dropped,
          events: [...cur.events, ...(res.events ?? [])].slice(-200),
        };
        for (const ev of res.events ?? []) {
          if (ev.kind === "digest" && ev.digest) next.digest = ev.digest;
          if (ev.kind === "error" && ev.text) {
            next.phase = "error";
            next.error = ev.text;
          }
          if (ev.kind === "done") next.phase = "done";
        }
        if (res.exited && next.phase === "pulling") {
          next.phase = res.exit_code === 0 ? "done" : "error";
          if (next.phase === "error" && !next.error) {
            next.error = `pull exited ${res.exit_code ?? "?"}`;
          }
        }
        return { ...h, pulls: { ...h.pulls, [jobId]: next } };
      });
      const after = useDockerStore.getState().byHost[hostId]?.pulls[jobId];
      if (after && after.phase === "done") {
        await useDockerStore.getState().refreshImages(hostId);
      }
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        pulls: {
          ...h.pulls,
          [jobId]: { ...(h.pulls[jobId] ?? job), phase: "error", error: String(e) },
        },
      }));
    }
  },

  cancelPull: async (hostId, jobId) => {
    const job = useDockerStore.getState().byHost[hostId]?.pulls[jobId];
    if (job?.handle !== null && job?.handle !== undefined) {
      try {
        await sshRpc("docker_logs_kill", { handle: job.handle }, hostId);
      } catch {
        // best effort
      }
    }
    patch(set, hostId, (h) => {
      const cur = h.pulls[jobId] ?? job;
      return {
        ...h,
        pulls: {
          ...h.pulls,
          [jobId]: { ...cur, phase: "error" as const, error: "Cancelled." },
        },
      };
    });
  },

  dismissPull: (hostId, jobId) => {
    patch(set, hostId, (h) => {
      const pulls = { ...h.pulls };
      delete pulls[jobId];
      return { ...h, pulls };
    });
  },

  registryLogin: async (hostId, registry, username, password) => {
    patch(set, hostId, (h) => ({
      ...h,
      registries: {
        ...h.registries,
        [registry]: { loggedIn: false, busy: true, error: null },
      },
    }));
    try {
      // Password travels the token-authenticated RPC channel only, passed
      // to `docker login --password-stdin` server-side. The store holds
      // login state — never the credential.
      await sshRpc("docker_registry_login", { registry, username, password }, hostId);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("secrets_set", {
          service: "terax-ai",
          account: `docker-registry:${hostId}:${registry}`,
          password,
        });
      } catch {
        // keyring unavailable — login still succeeded for this session
      }
      patch(set, hostId, (h) => ({
        ...h,
        registries: {
          ...h.registries,
          [registry]: { loggedIn: true, busy: false, error: null },
        },
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        registries: {
          ...h.registries,
          [registry]: { loggedIn: false, busy: false, error: String(e) },
        },
      }));
    }
  },

  registryLogout: async (hostId, registry) => {
    patch(set, hostId, (h) => ({
      ...h,
      registries: {
        ...h.registries,
        [registry]: { loggedIn: false, busy: true, error: null },
      },
    }));
    try {
      await sshRpc("docker_registry_logout", { registry }, hostId);
    } catch {
      // best effort — still clear local state
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("secrets_delete", {
        service: "terax-ai",
        account: `docker-registry:${hostId}:${registry}`,
      });
    } catch {
      // already absent — fine
    }
    patch(set, hostId, (h) => ({
      ...h,
      registries: {
        ...h.registries,
        [registry]: { loggedIn: false, busy: false, error: null },
      },
    }));
  },

  startLogFollow: (hostId, kind, id, options) => {
    const followId = `${kind}:${id}`;
    const opts: LogViewOptions = {
      timestamps: options?.timestamps ?? true,
      tail: options?.tail ?? 500,
      since: options?.since ?? "",
    };
    const follow: LogFollowState = {
      handle: null,
      phase: "starting",
      lines: [],
      offset: 0,
      dropped: 0,
      exited: false,
      exitCode: null,
      error: null,
      options: opts,
    };
    patch(set, hostId, (h) => ({
      ...h,
      logFollows: { ...h.logFollows, [followId]: follow },
    }));
    void (async () => {
      try {
        const params =
          kind === "container"
            ? {
                container: id,
                timestamps: opts.timestamps,
                tail: opts.tail,
                ...(opts.since ? { since: opts.since } : {}),
              }
            : { service: id, tail: opts.tail };
        const method = kind === "container" ? "docker_logs_spawn" : "docker_service_logs";
        // Services use one-shot logs (no follow lane on the agent); the
        // follow state still gives the pane a uniform shape.
        const info = await sshRpc<{ handle?: number; output?: string }>(
          method,
          params,
          hostId,
        );
        patch(set, hostId, (h) => ({
          ...h,
          logFollows: {
            ...h.logFollows,
            [followId]: {
              ...(h.logFollows[followId] ?? follow),
              handle: info.handle ?? null,
              phase: kind === "container" ? "following" : "done",
              lines:
                kind === "container"
                  ? []
                  : String(info.output ?? "").split("\n"),
              exited: kind !== "container",
            },
          },
        }));
        if (kind === "container") {
          await useDockerStore.getState().pollLogFollow(hostId, followId);
        }
      } catch (e) {
        patch(set, hostId, (h) => ({
          ...h,
          logFollows: {
            ...h.logFollows,
            [followId]: {
              ...(h.logFollows[followId] ?? follow),
              phase: "error",
              error: String(e),
            },
          },
        }));
      }
    })();
    return followId;
  },

  pollLogFollow: async (hostId, followId) => {
    const follow = useDockerStore.getState().byHost[hostId]?.logFollows[followId];
    if (!follow || follow.handle === null || follow.phase === "done" || follow.phase === "error") {
      return;
    }
    try {
      const res = await sshRpc<{
        bytes: string;
        next_offset: number;
        dropped: number;
        exited: boolean;
        exit_code: number | null;
      }>("docker_logs_poll", { handle: follow.handle, sinceOffset: follow.offset }, hostId);
      patch(set, hostId, (h) => {
        const cur = h.logFollows[followId] ?? follow;
        const chunk = res.bytes ?? "";
        const next: LogFollowState = {
          ...cur,
          lines: chunk
            ? [...cur.lines, ...chunk.split("\n")].slice(-5000)
            : cur.lines,
          offset: res.next_offset ?? cur.offset,
          dropped: Math.max(cur.dropped, res.dropped ?? 0),
          exited: res.exited,
          exitCode: res.exit_code,
          phase: res.exited ? "done" : "following",
        };
        return { ...h, logFollows: { ...h.logFollows, [followId]: next } };
      });
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        logFollows: {
          ...h.logFollows,
          [followId]: { ...(h.logFollows[followId] ?? follow), phase: "error", error: String(e) },
        },
      }));
    }
  },

  stopLogFollow: async (hostId, followId) => {
    const follow = useDockerStore.getState().byHost[hostId]?.logFollows[followId];
    if (follow?.handle !== null && follow?.handle !== undefined) {
      try {
        await sshRpc("docker_logs_kill", { handle: follow.handle }, hostId);
      } catch {
        // best effort
      }
    }
    patch(set, hostId, (h) => {
      const next = { ...h.logFollows };
      delete next[followId];
      return { ...h, logFollows: next };
    });
  },

  setLogOptions: (hostId, followId, options) => {
    const cur = useDockerStore.getState().byHost[hostId]?.logFollows[followId];
    if (!cur) return;
    const kind = followId.startsWith("service:") ? ("service" as const) : ("container" as const);
    const id = followId.slice(followId.indexOf(":") + 1);
    void useDockerStore.getState().stopLogFollow(hostId, followId).then(() => {
      useDockerStore.getState().startLogFollow(hostId, kind, id, {
        ...cur.options,
        ...options,
      });
    });
  },

  startEventsFeed: async (hostId, filter) => {
    const cur = useDockerStore.getState().byHost[hostId]?.eventsFeed;
    if (cur && (cur.phase === "streaming" || cur.phase === "starting")) return;
    patch(set, hostId, (h) => ({
      ...h,
      eventsFeed: { handle: null, phase: "starting", events: [], offset: 0, dropped: 0, error: null },
    }));
    try {
      const info = await sshRpc<{ handle: number }>(
        "docker_events_spawn",
        filter ? { filter } : {},
        hostId,
      );
      patch(set, hostId, (h) => ({
        ...h,
        eventsFeed: { ...(h.eventsFeed ?? { handle: null, phase: "starting" as const, events: [], offset: 0, dropped: 0, error: null }), handle: info.handle, phase: "streaming" },
      }));
      await useDockerStore.getState().pollEventsFeed(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        eventsFeed: { handle: null, phase: "error", events: [], offset: 0, dropped: 0, error: String(e) },
      }));
    }
  },

  pollEventsFeed: async (hostId) => {
    const feed = useDockerStore.getState().byHost[hostId]?.eventsFeed;
    if (!feed || feed.handle === null || feed.phase === "done" || feed.phase === "error") return;
    try {
      const res = await sshRpc<{
        bytes: string;
        next_offset: number;
        dropped: number;
        exited: boolean;
        exit_code: number | null;
      }>("docker_events_poll", { handle: feed.handle, sinceOffset: feed.offset }, hostId);
      const fresh: DockerEvent[] = String(res.bytes ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as DockerEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is DockerEvent => e !== null);
      patch(set, hostId, (h) => {
        const curFeed = h.eventsFeed ?? feed;
        return {
          ...h,
          eventsFeed: {
            ...curFeed,
            events: [...curFeed.events, ...fresh].slice(-500),
            offset: res.next_offset ?? curFeed.offset,
            dropped: Math.max(curFeed.dropped, res.dropped ?? 0),
            phase: res.exited ? "done" : "streaming",
          },
        };
      });
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        eventsFeed: { ...(h.eventsFeed ?? feed), phase: "error", error: String(e) },
      }));
    }
  },

  stopEventsFeed: async (hostId) => {
    const feed = useDockerStore.getState().byHost[hostId]?.eventsFeed;
    if (feed?.handle !== null && feed?.handle !== undefined) {
      try {
        await sshRpc("docker_events_kill", { handle: feed.handle }, hostId);
      } catch {
        // best effort
      }
    }
    patch(set, hostId, (h) => ({ ...h, eventsFeed: null }));
  },

  setRuleMuted: (hostId, rule, muted) => {
    patch(set, hostId, (h) => ({
      ...h,
      notifyMute: { ...h.notifyMute, [rule]: muted },
    }));
  },

  isRuleMuted: (hostId: string, rule: string): boolean => {
    return useDockerStore.getState().byHost[hostId]?.notifyMute[rule] ?? false;
  },
}));

export function hostDocker(hostId: string | null): HostDockerState {
  if (!hostId) return emptyHost();
  return useDockerStore.getState().byHost[hostId] ?? emptyHost();
}

export function mutedRules(hostId: string): string[] {
  const mute = useDockerStore.getState().byHost[hostId]?.notifyMute ?? {};
  return ALL_RULES.filter((r) => mute[r]);
}
