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

export type ContainerAction = "start" | "stop" | "restart" | "kill" | "remove";

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

export type PruneTarget =
  | "containers"
  | "images"
  | "volumes"
  | "networks"
  | "builder"
  | "system";

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
  registries: Record<
    string,
    { loggedIn: boolean; busy: boolean; error: string | null }
  >;
  /** Pull jobs keyed by local job id. */
  pulls: Record<string, PullJob>;
  /** Live log follows keyed by `container:<id>` or `service:<id>`. */
  logFollows: Record<string, LogFollowState>;
  /** `docker events` stream (one per host). */
  eventsFeed: EventsFeedState | null;
  /** Muted notification rule kinds per host. */
  notifyMute: Record<string, boolean>;
  /** Compose projects keyed by project name. */
  compose: Record<string, ComposeProjectState>;
  /** Swarm overview (nodes/services/stacks) for swarm-active hosts. */
  swarm: SwarmState;
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
  /** Self-heal budget: respawns left after the agent loses our handle
   *  (lane death). Reset on every successful spawn. */
  healsLeft: number;
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
  /** Self-heal budget: respawns left after the agent loses our handle
   *  (lane death). Reset on every successful spawn. */
  healsLeft: number;
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
  /** Self-heal budget: respawns left after the agent loses our handle
   *  (lane death). Reset on every successful spawn. */
  healsLeft: number;
  /** Spawn filter (respawn must replay it). */
  filter: string;
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

export type ComposeProjectState = {
  name: string;
  /** Compose files backing the project (authorized paths). */
  files: string[];
  projectDir: string;
  /** Containers belonging to the project (by container id). */
  containers: string[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
};

export type SwarmNode = {
  ID?: string;
  Hostname?: string;
  Status?: string;
  Availability?: string;
  ManagerStatus?: string;
  EngineVersion?: string;
  [key: string]: unknown;
};

export type SwarmService = {
  ID?: string;
  Name?: string;
  Mode?: string;
  Replicas?: string;
  Image?: string;
  replicaHealth?: {
    running: number;
    desired: number;
    underReplicated: boolean;
  };
  [key: string]: unknown;
};

export type SwarmStack = {
  Name?: string;
  Services?: string;
  [key: string]: unknown;
};

export type SwarmInfo = {
  LocalNodeState?: string;
  ControlAvailable?: boolean;
  [key: string]: unknown;
};

export type SwarmSecret = {
  ID?: string;
  Name?: string;
  CreatedAt?: string;
  UpdatedAt?: string;
  [key: string]: unknown;
};

export type SwarmConfig = {
  ID?: string;
  Name?: string;
  CreatedAt?: string;
  UpdatedAt?: string;
  [key: string]: unknown;
};

export type SwarmState = {
  info: SwarmInfo | null;
  nodes: SwarmNode[];
  services: SwarmService[];
  stacks: SwarmStack[];
  secrets: SwarmSecret[];
  configs: SwarmConfig[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  busyService: Record<string, string>;
  drift: Record<string, { running: string[]; desired: string[] }>;
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
    compose: {},
    swarm: {
      info: null,
      nodes: [],
      services: [],
      stacks: [],
      secrets: [],
      configs: [],
      loading: false,
      error: null,
      updatedAt: null,
      busyService: {},
      drift: {},
    },
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
  removeVolume: (hostId: string, name: string) => Promise<void>;
  removeNetwork: (hostId: string, name: string) => Promise<void>;
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
  /** Re-issue the spawn for a stale pull (self-heal). Internal. */
  respawnPull: (hostId: string, jobId: string) => Promise<void>;
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
  /** Re-issue the spawn for a stale follow (self-heal). Internal. */
  respawnLogFollow: (hostId: string, followId: string) => Promise<void>;
  stopLogFollow: (hostId: string, followId: string) => Promise<void>;
  setLogOptions: (
    hostId: string,
    followId: string,
    options: Partial<LogViewOptions>,
  ) => void;
  startEventsFeed: (hostId: string, filter?: string) => Promise<void>;
  pollEventsFeed: (hostId: string) => Promise<void>;
  /** Re-issue the spawn for a stale feed (self-heal). Internal. */
  respawnEventsFeed: (hostId: string) => Promise<void>;
  stopEventsFeed: (hostId: string) => Promise<void>;
  setRuleMuted: (hostId: string, rule: string, muted: boolean) => void;
  isRuleMuted: (hostId: string, rule: string) => boolean;
  detectCompose: (hostId: string, dir: string) => Promise<string[]>;
  refreshCompose: (
    hostId: string,
    project: string,
    files: string[],
    projectDir?: string,
  ) => Promise<void>;
  composeAction: (
    hostId: string,
    project: string,
    action: "up" | "down" | "restart" | "pull",
    opts?: { build?: boolean; volumes?: boolean; services?: string[] },
  ) => Promise<void>;
  refreshSwarm: (hostId: string) => Promise<void>;
  refreshSwarmSecrets: (hostId: string) => Promise<void>;
  serviceAction: (
    hostId: string,
    action: "scale" | "update-image" | "rm" | "rollback",
    service: string,
    opts?: { replicas?: number; image?: string },
  ) => Promise<void>;
  stackAction: (
    hostId: string,
    action: "deploy" | "rm",
    stack: string,
    composeFile?: string,
  ) => Promise<void>;
  nodeAction: (
    hostId: string,
    action: "drain" | "activate" | "pause" | "promote" | "demote",
    node: string,
  ) => Promise<void>;
  swarmInit: (hostId: string, advertiseAddr?: string) => Promise<void>;
  swarmJoin: (hostId: string, token: string, addr: string) => Promise<void>;
  swarmLeave: (hostId: string, force?: boolean) => Promise<void>;
  secretCreate: (hostId: string, name: string, value: string) => Promise<void>;
  secretRemove: (hostId: string, name: string) => Promise<void>;
  configCreate: (hostId: string, name: string, file: string) => Promise<void>;
  configRemove: (hostId: string, name: string) => Promise<void>;
  refreshStackDrift: (
    hostId: string,
    stack: string,
    composeFile: string,
  ) => Promise<void>;
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

/** Pane refcount per follow id so drawer + tab for the same container
 *  share one agent lane instead of spawning/killing on every open. */
const followRefs = new Map<string, number>();

export function retainLogFollow(followId: string): void {
  followRefs.set(followId, (followRefs.get(followId) ?? 0) + 1);
}

/**
 * Self-heal budget for background follows. When the agent loses our handle
 * (lane death: pool respawn, agent restart), the next poll fails with
 * `no_handle`. Instead of parking the UI in error, each follow respawns
 * its lane transparently — up to MAX_HEALS times per follow lifetime, then
 * it surfaces the error for real. The budget resets on every successful
 * spawn, so a flapping lane heals indefinitely while a truly dead daemon
 * still fails visibly after 3 attempts.
 */
export const MAX_HEALS = 3;

/** True when an ssh_rpc failure means "the agent has no such handle"
 *  (lane died or never saw the spawn) as opposed to a real error. The
 *  agent's code is `no_handle`; match the message too for old agents. */
export function isStaleHandleError(e: unknown): boolean {
  const msg = String(e);
  return msg.includes("no_handle") || msg.includes("no background handle");
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
          daemon: {
            status: "not-installed",
            message: "Docker is not installed on this host.",
          },
        }));
        return;
      }
      if (!caps.daemonRunning) {
        patch(set, hostId, (h) => ({
          ...h,
          daemon: {
            status: "daemon-down",
            message: "Docker daemon is not running.",
          },
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
      const items = await sshRpc<DockerContainer[]>(
        "docker_ps",
        { all },
        hostId,
      );
      patch(set, hostId, (h) => ({
        ...h,
        containers: {
          items,
          loading: false,
          error: null,
          updatedAt: Date.now(),
        },
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
      const items = await sshRpc<DockerVolume[]>(
        "docker_volumes_ls",
        {},
        hostId,
      );
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
      const items = await sshRpc<DockerNetwork[]>(
        "docker_networks_ls",
        {},
        hostId,
      );
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

  removeVolume: async (hostId, name) => {
    try {
      await sshRpc("docker_volume_rm", { names: [name] }, hostId);
      await useDockerStore.getState().refreshVolumes(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        volumes: { ...h.volumes, error: String(e) },
      }));
    }
  },

  removeNetwork: async (hostId, name) => {
    try {
      await sshRpc("docker_network_rm", { names: [name] }, hostId);
      await useDockerStore.getState().refreshNetworks(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        networks: { ...h.networks, error: String(e) },
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
      const method = action === "remove" ? "docker_rm" : `docker_${action}`;
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
      const data = await sshRpc<unknown>(
        "docker_inspect",
        { kind, id },
        hostId,
      );
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
      healsLeft: MAX_HEALS,
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
            [jobId]: {
              ...(h.pulls[jobId] ?? job),
              handle: info.handle,
              phase: "pulling",
              healsLeft: MAX_HEALS,
            },
          },
        }));
        await useDockerStore.getState().pollPull(hostId, jobId);
      } catch (e) {
        patch(set, hostId, (h) => ({
          ...h,
          pulls: {
            ...h.pulls,
            [jobId]: {
              ...(h.pulls[jobId] ?? job),
              phase: "error",
              error: String(e),
            },
          },
        }));
      }
    })();
    return jobId;
  },

  pollPull: async (hostId, jobId) => {
    const job = useDockerStore.getState().byHost[hostId]?.pulls[jobId];
    if (
      !job ||
      job.handle === null ||
      job.phase === "done" ||
      job.phase === "error"
    )
      return;
    // Drain loop: the agent caps each poll chunk (truncated=true) so the
    // frame never blows the transport cap. Keep polling with the advanced
    // offset until a non-truncated chunk arrives — one UI tick per drain.
    for (let i = 0; i < 8; i++) {
      const cur = useDockerStore.getState().byHost[hostId]?.pulls[jobId];
      if (
        !cur ||
        cur.handle === null ||
        cur.phase === "done" ||
        cur.phase === "error"
      )
        return;
      let res: {
        bytes: string;
        nextOffset?: number;
        next_offset?: number;
        dropped: number;
        exited: boolean;
        exitCode?: number | null;
        exit_code?: number | null;
        truncated?: boolean;
        events?: import("./types").PullProgressEvent[];
      };
      try {
        res = await sshRpc(
          // Pull procs live in the agent's events map (not logs) — poll with
          // docker_events_poll so the progress parser runs server-side.
          "docker_events_poll",
          { handle: cur.handle, sinceOffset: cur.offset },
          hostId,
        );
        if (!res || typeof res !== "object") {
          res = { bytes: "", dropped: 0, exited: false } as typeof res;
        }
      } catch (e) {
        // Lane death: the agent lost our handle (pool respawn / restart).
        // Respawn the pull transparently while budget remains — the new
        // `docker pull` resumes completed layers, so this is cheap.
        if (isStaleHandleError(e) && cur.healsLeft > 0) {
          patch(set, hostId, (h) => ({
            ...h,
            pulls: {
              ...h.pulls,
              [jobId]: {
                ...(h.pulls[jobId] ?? job),
                handle: null,
                phase: "starting",
                healsLeft: cur.healsLeft - 1,
                error: null,
              },
            },
          }));
          await useDockerStore.getState().respawnPull(hostId, jobId);
          return;
        }
        patch(set, hostId, (h) => ({
          ...h,
          pulls: {
            ...h.pulls,
            [jobId]: {
              ...(h.pulls[jobId] ?? job),
              phase: "error",
              error: String(e),
            },
          },
        }));
        return;
      }
      patch(set, hostId, (h) => {
        const prev = h.pulls[jobId] ?? job;
        const exitCode = res.exitCode ?? res.exit_code ?? null;
        const next: PullJob = {
          ...prev,
          output: prev.output + (res.bytes ?? ""),
          offset: res.nextOffset ?? res.next_offset ?? prev.offset,
          dropped:
            (res.dropped ?? 0) > prev.dropped
              ? (res.dropped ?? 0)
              : prev.dropped,
          events: [...prev.events, ...(res.events ?? [])].slice(-200),
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
          next.phase = exitCode === 0 ? "done" : "error";
          if (next.phase === "error" && !next.error) {
            next.error = `pull exited ${exitCode ?? "?"}`;
          }
        }
        return { ...h, pulls: { ...h.pulls, [jobId]: next } };
      });
      if (!res.truncated) break;
    }
    const after = useDockerStore.getState().byHost[hostId]?.pulls[jobId];
    if (after && after.phase === "done") {
      await useDockerStore.getState().refreshImages(hostId);
    }
  },

  respawnPull: async (hostId, jobId) => {
    const job = useDockerStore.getState().byHost[hostId]?.pulls[jobId];
    // Guard on phase only: the heal path sets handle=null + starting, and
    // the stale handle value is meaningless once the lane died.
    if (job?.phase !== "starting") return;
    try {
      const info = await sshRpc<{ handle: number }>(
        "docker_pull",
        {
          reference: job.reference,
          ...(job.platform ? { platform: job.platform } : {}),
          ...(job.quiet ? { quiet: true } : {}),
        },
        hostId,
      );
      patch(set, hostId, (h) => ({
        ...h,
        pulls: {
          ...h.pulls,
          [jobId]: {
            ...(h.pulls[jobId] ?? job),
            handle: info.handle,
            phase: "pulling",
            // Offset resets: the new lane's ring starts empty. Progress
            // replays from the daemon (completed layers are instant).
            offset: 0,
          },
        },
      }));
      await useDockerStore.getState().pollPull(hostId, jobId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        pulls: {
          ...h.pulls,
          [jobId]: {
            ...(h.pulls[jobId] ?? job),
            phase: "error",
            error: String(e),
          },
        },
      }));
    }
  },

  cancelPull: async (hostId, jobId) => {
    const job = useDockerStore.getState().byHost[hostId]?.pulls[jobId];
    if (job?.handle !== null && job?.handle !== undefined) {
      try {
        await sshRpc("docker_events_kill", { handle: job.handle }, hostId);
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
      await sshRpc(
        "docker_registry_login",
        { registry, username, password },
        hostId,
      );
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
    // Reuse a live follow instead of spawning a duplicate lane: reopening
    // the pane for the same container must attach to the existing stream,
    // not orphan a second `docker logs -f` on the agent.
    const live = useDockerStore.getState().byHost[hostId]?.logFollows[followId];
    if (
      live &&
      (live.phase === "following" || live.phase === "starting") &&
      live.handle !== null
    ) {
      return followId;
    }
    if (live && live.phase === "following" && live.handle === null) {
      // Spawn raced but hasn't returned yet; the in-flight spawn owns it.
      return followId;
    }
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
      healsLeft: MAX_HEALS,
    };
    patch(set, hostId, (h) => ({
      ...h,
      logFollows: { ...h.logFollows, [followId]: follow },
    }));
    void (async () => {
      let info: { handle?: number; output?: string };
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
        const method =
          kind === "container" ? "docker_logs_spawn" : "docker_service_logs";
        // Services use one-shot logs (no follow lane on the agent); the
        // follow state still gives the pane a uniform shape.
        info = await sshRpc<{ handle?: number; output?: string }>(
          method,
          params,
          hostId,
        );
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
        return;
      }
      if (typeof info.handle !== "number") {
        patch(set, hostId, (h) => ({
          ...h,
          logFollows: {
            ...h.logFollows,
            [followId]: {
              ...(h.logFollows[followId] ?? follow),
              phase: "error",
              error: "agent did not return a log handle",
            },
          },
        }));
        return;
      }
      patch(set, hostId, (h) => ({
        ...h,
        logFollows: {
          ...h.logFollows,
          [followId]: {
            ...(h.logFollows[followId] ?? follow),
            handle: info.handle ?? null,
            phase: kind === "container" ? "following" : "done",
            lines:
              kind === "container" ? [] : String(info.output ?? "").split("\n"),
            exited: kind !== "container",
            healsLeft: MAX_HEALS,
          },
        },
      }));
      if (kind === "container") {
        await useDockerStore.getState().pollLogFollow(hostId, followId);
      }
    })();
    return followId;
  },

  pollLogFollow: async (hostId, followId) => {
    const follow =
      useDockerStore.getState().byHost[hostId]?.logFollows[followId];
    if (
      !follow ||
      follow.handle === null ||
      follow.phase === "done" ||
      follow.phase === "error"
    ) {
      return;
    }
    // Drain loop: the agent caps each chunk (truncated=true) under the
    // frame cap. A chatty container can out-produce one chunk per 1.5s
    // tick; draining up to 8 chunks per tick keeps the view live without
    // extra timers. Each iteration resumes from the advanced offset, so
    // chunks chain losslessly.
    let exited = false;
    for (let i = 0; i < 8; i++) {
      const cur0 =
        useDockerStore.getState().byHost[hostId]?.logFollows[followId];
      if (
        !cur0 ||
        cur0.handle === null ||
        cur0.phase === "done" ||
        cur0.phase === "error"
      )
        return;
      let res: {
        bytes: string;
        nextOffset?: number;
        next_offset?: number;
        dropped: number;
        exited: boolean;
        exitCode?: number | null;
        exit_code?: number | null;
        truncated?: boolean;
      };
      try {
        res = await sshRpc(
          "docker_logs_poll",
          { handle: cur0.handle, sinceOffset: cur0.offset },
          hostId,
        );
        // A resolving-but-empty transport (mock default, proxy hiccup)
        // must not crash the drain loop — treat as an empty clean chunk.
        if (!res || typeof res !== "object") {
          res = { bytes: "", dropped: 0, exited: false } as typeof res;
        }
      } catch (e) {
        // Lane death: the agent lost our handle. Respawn transparently
        // while budget remains — the new `docker logs -f --tail` replays
        // the tail, so the view backfills instead of erroring.
        if (isStaleHandleError(e) && cur0.healsLeft > 0) {
          patch(set, hostId, (h) => ({
            ...h,
            logFollows: {
              ...h.logFollows,
              [followId]: {
                ...(h.logFollows[followId] ?? follow),
                handle: null,
                phase: "starting",
                healsLeft: cur0.healsLeft - 1,
                error: null,
              },
            },
          }));
          await useDockerStore.getState().respawnLogFollow(hostId, followId);
          return;
        }
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
        return;
      }
      patch(set, hostId, (h) => {
        const cur = h.logFollows[followId] ?? follow;
        const chunk = res.bytes ?? "";
        const nextOffset = res.nextOffset ?? res.next_offset ?? cur.offset;
        const exitCode = res.exitCode ?? res.exit_code ?? null;
        exited = res.exited;
        const next: LogFollowState = {
          ...cur,
          lines: chunk
            ? [...cur.lines, ...chunk.split("\n")].slice(-5000)
            : cur.lines,
          offset: nextOffset,
          dropped: Math.max(cur.dropped, res.dropped ?? 0),
          exited: res.exited,
          exitCode,
          phase: res.exited ? "done" : "following",
        };
        return { ...h, logFollows: { ...h.logFollows, [followId]: next } };
      });
      if (!res.truncated || exited) break;
    }
  },

  respawnLogFollow: async (hostId, followId) => {
    const cur = useDockerStore.getState().byHost[hostId]?.logFollows[followId];
    // Guard on phase only (see respawnPull): the handle is stale by
    // definition on this path.
    if (cur?.phase !== "starting") return;
    const sep = followId.indexOf(":");
    const kind = followId.startsWith("service:")
      ? ("service" as const)
      : ("container" as const);
    const id = followId.slice(sep + 1);
    if (kind !== "container") return;
    try {
      const info = await sshRpc<{ handle?: number }>(
        "docker_logs_spawn",
        {
          container: id,
          timestamps: cur.options.timestamps,
          tail: cur.options.tail,
          ...(cur.options.since ? { since: cur.options.since } : {}),
        },
        hostId,
      );
      if (typeof info.handle !== "number")
        throw new Error("agent did not return a log handle");
      patch(set, hostId, (h) => ({
        ...h,
        logFollows: {
          ...h.logFollows,
          [followId]: {
            ...(h.logFollows[followId] ?? cur),
            handle: info.handle ?? null,
            phase: "following",
          },
        },
      }));
      await useDockerStore.getState().pollLogFollow(hostId, followId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        logFollows: {
          ...h.logFollows,
          [followId]: {
            ...(h.logFollows[followId] ?? cur),
            phase: "error",
            error: String(e),
          },
        },
      }));
    }
  },

  stopLogFollow: async (hostId, followId) => {
    // Drawer opens/closes share one follow per container: only kill the
    // agent lane when nobody is watching. The refcount below tracks
    // mounted panes; the last unmount kills the lane.
    const refs = followRefs.get(followId) ?? 0;
    if (refs > 1) {
      followRefs.set(followId, refs - 1);
      return;
    }
    followRefs.delete(followId);
    const follow =
      useDockerStore.getState().byHost[hostId]?.logFollows[followId];
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
    const kind = followId.startsWith("service:")
      ? ("service" as const)
      : ("container" as const);
    const id = followId.slice(followId.indexOf(":") + 1);
    void useDockerStore
      .getState()
      .stopLogFollow(hostId, followId)
      .then(() => {
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
      eventsFeed: {
        handle: null,
        phase: "starting",
        events: [],
        offset: 0,
        dropped: 0,
        error: null,
        healsLeft: MAX_HEALS,
        filter: filter ?? "",
      },
    }));
    try {
      const info = await sshRpc<{ handle: number }>(
        "docker_events_spawn",
        filter ? { filter } : {},
        hostId,
      );
      patch(set, hostId, (h) => ({
        ...h,
        eventsFeed: {
          ...(h.eventsFeed ?? {
            handle: null,
            phase: "starting" as const,
            events: [],
            offset: 0,
            dropped: 0,
            error: null,
            healsLeft: MAX_HEALS,
            filter: filter ?? "",
          }),
          handle: info.handle,
          phase: "streaming",
          healsLeft: MAX_HEALS,
        },
      }));
      await useDockerStore.getState().pollEventsFeed(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        eventsFeed: {
          handle: null,
          phase: "error",
          events: [],
          offset: 0,
          dropped: 0,
          error: String(e),
          healsLeft: MAX_HEALS,
          filter: filter ?? "",
        },
      }));
    }
  },

  pollEventsFeed: async (hostId) => {
    const feed = useDockerStore.getState().byHost[hostId]?.eventsFeed;
    if (
      !feed ||
      feed.handle === null ||
      feed.phase === "done" ||
      feed.phase === "error"
    )
      return;
    // Drain loop (same rationale as pollLogFollow): a burst of daemon
    // events can exceed one capped chunk per tick.
    for (let i = 0; i < 8; i++) {
      const cur0 = useDockerStore.getState().byHost[hostId]?.eventsFeed;
      if (
        !cur0 ||
        cur0.handle === null ||
        cur0.phase === "done" ||
        cur0.phase === "error"
      )
        return;
      let res: {
        bytes: string;
        nextOffset?: number;
        next_offset?: number;
        dropped: number;
        exited: boolean;
        truncated?: boolean;
      };
      try {
        res = await sshRpc(
          "docker_events_poll",
          { handle: cur0.handle, sinceOffset: cur0.offset },
          hostId,
        );
        if (!res || typeof res !== "object") {
          res = { bytes: "", dropped: 0, exited: false } as typeof res;
        }
      } catch (e) {
        // Lane death: respawn the feed transparently while budget remains.
        // `docker events` is a live tail — history during the gap is lost,
        // but the feed resumes instead of parking in error.
        if (isStaleHandleError(e) && cur0.healsLeft > 0) {
          patch(set, hostId, (h) => ({
            ...h,
            eventsFeed: {
              ...(h.eventsFeed ?? feed),
              handle: null,
              phase: "starting",
              healsLeft: cur0.healsLeft - 1,
              error: null,
            },
          }));
          await useDockerStore.getState().respawnEventsFeed(hostId);
          return;
        }
        patch(set, hostId, (h) => ({
          ...h,
          eventsFeed: {
            ...(h.eventsFeed ?? feed),
            phase: "error",
            error: String(e),
          },
        }));
        return;
      }
      // A capped chunk may split a JSON line mid-object; only the trailing
      // fragment can be partial (offsets are byte-exact), so hold it back
      // and prepend it to the next chunk.
      const raw = String(res.bytes ?? "");
      const endsClean = raw === "" || raw.endsWith("\n");
      const complete = endsClean
        ? raw
        : raw.slice(0, raw.lastIndexOf("\n") + 1);
      const carry = endsClean ? "" : raw.slice(raw.lastIndexOf("\n") + 1);
      const fresh: DockerEvent[] = complete
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
      const carryBytes = new TextEncoder().encode(carry).length;
      let done = false;
      patch(set, hostId, (h) => {
        const curFeed = h.eventsFeed ?? feed;
        done = res.exited;
        return {
          ...h,
          eventsFeed: {
            ...curFeed,
            events: [...curFeed.events, ...fresh].slice(-500),
            // Rewind past the held-back fragment so the next poll re-reads
            // it whole; complete lines still advance exactly once.
            offset:
              (res.nextOffset ?? res.next_offset ?? curFeed.offset) -
              carryBytes,
            dropped: Math.max(curFeed.dropped, res.dropped ?? 0),
            phase: res.exited ? "done" : "streaming",
          },
        };
      });
      if (!res.truncated || done) break;
    }
  },

  respawnEventsFeed: async (hostId) => {
    const cur = useDockerStore.getState().byHost[hostId]?.eventsFeed;
    // Guard on phase only (see respawnPull).
    if (cur?.phase !== "starting") return;
    try {
      const info = await sshRpc<{ handle: number }>(
        "docker_events_spawn",
        cur.filter ? { filter: cur.filter } : {},
        hostId,
      );
      patch(set, hostId, (h) => ({
        ...h,
        eventsFeed: {
          ...(h.eventsFeed ?? cur),
          handle: info.handle,
          phase: "streaming",
          // Offset resets: the new lane's ring starts empty.
          offset: 0,
        },
      }));
      await useDockerStore.getState().pollEventsFeed(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        eventsFeed: {
          ...(h.eventsFeed ?? cur),
          phase: "error",
          error: String(e),
        },
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

  detectCompose: async (hostId, dir) => {
    const res = await sshRpc<{ files: string[] }>(
      "docker_compose_detect",
      { dir },
      hostId,
    );
    return res.files ?? [];
  },

  refreshCompose: async (hostId, project, files, projectDir) => {
    patch(set, hostId, (h) => ({
      ...h,
      compose: {
        ...h.compose,
        [project]: {
          name: project,
          files,
          projectDir: projectDir ?? "",
          containers: h.compose[project]?.containers ?? [],
          loading: true,
          error: null,
          updatedAt: h.compose[project]?.updatedAt ?? null,
        },
      },
    }));
    try {
      const items = await sshRpc<{ ID?: string; Id?: string; Name?: string }[]>(
        "docker_compose_ps",
        { files, ...(projectDir ? { projectDir } : {}) },
        hostId,
      );
      patch(set, hostId, (h) => ({
        ...h,
        compose: {
          ...h.compose,
          [project]: {
            name: project,
            files,
            projectDir: projectDir ?? "",
            containers: items
              .map((c) => String(c.ID ?? c.Id ?? c.Name ?? ""))
              .filter(Boolean),
            loading: false,
            error: null,
            updatedAt: Date.now(),
          },
        },
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        compose: {
          ...h.compose,
          [project]: {
            name: project,
            files,
            projectDir: projectDir ?? "",
            containers: [],
            loading: false,
            error: String(e),
            updatedAt: null,
          },
        },
      }));
    }
  },

  composeAction: async (hostId, project, action, opts) => {
    const files =
      useDockerStore.getState().byHost[hostId]?.compose[project]?.files ?? [];
    if (files.length === 0) return;
    patch(set, hostId, (h) => ({
      ...h,
      compose: {
        ...h.compose,
        [project]: {
          ...(h.compose[project] ?? {
            name: project,
            files,
            projectDir: "",
            containers: [],
            updatedAt: null,
          }),
          loading: true,
          error: null,
        },
      },
    }));
    try {
      const method =
        action === "up"
          ? "docker_compose_up"
          : action === "down"
            ? "docker_compose_down"
            : action === "restart"
              ? "docker_compose_restart"
              : "docker_compose_pull";
      await sshRpc(
        method,
        {
          files,
          ...(opts?.build ? { build: true } : {}),
          ...(opts?.volumes ? { volumes: true } : {}),
          ...(opts?.services?.length ? { services: opts.services } : {}),
        },
        hostId,
      );
      await useDockerStore.getState().refreshCompose(hostId, project, files);
      await useDockerStore.getState().refreshContainers(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        compose: {
          ...h.compose,
          [project]: {
            ...(h.compose[project] ?? {
              name: project,
              files,
              projectDir: "",
              containers: [],
              updatedAt: null,
            }),
            loading: false,
            error: String(e),
          },
        },
      }));
    }
  },

  refreshSwarm: async (hostId) => {
    patch(set, hostId, (h) => ({
      ...h,
      swarm: { ...h.swarm, loading: true, error: null },
    }));
    try {
      const [info, nodes, services, stacks] = await Promise.all([
        sshRpc<SwarmInfo>("docker_swarm_info", {}, hostId),
        sshRpc<SwarmNode[]>("docker_node_ls", {}, hostId).catch(
          () => [] as SwarmNode[],
        ),
        sshRpc<SwarmService[]>("docker_service_ls", {}, hostId).catch(
          () => [] as SwarmService[],
        ),
        sshRpc<SwarmStack[]>("docker_stack_ls", {}, hostId).catch(
          () => [] as SwarmStack[],
        ),
      ]);
      patch(set, hostId, (h) => ({
        ...h,
        swarm: {
          ...h.swarm,
          info,
          nodes,
          services,
          stacks,
          loading: false,
          error: null,
          updatedAt: Date.now(),
        },
      }));
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, loading: false, error: String(e) },
      }));
    }
  },

  refreshSwarmSecrets: async (hostId) => {
    try {
      const [secrets, configs] = await Promise.all([
        sshRpc<SwarmSecret[]>("docker_secret_ls", {}, hostId).catch(
          () => [] as SwarmSecret[],
        ),
        sshRpc<SwarmConfig[]>("docker_config_ls", {}, hostId).catch(
          () => [] as SwarmConfig[],
        ),
      ]);
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, secrets, configs },
      }));
    } catch {
      // best effort — list rows show their own errors
    }
  },

  serviceAction: async (hostId, action, service, opts) => {
    patch(set, hostId, (h) => ({
      ...h,
      swarm: {
        ...h.swarm,
        busyService: { ...h.swarm.busyService, [service]: action },
      },
    }));
    try {
      if (action === "scale") {
        await sshRpc(
          "docker_service_scale",
          { service, replicas: opts?.replicas ?? 1 },
          hostId,
        );
      } else if (action === "update-image") {
        await sshRpc(
          "docker_service_update",
          { service, image: opts?.image ?? "" },
          hostId,
        );
      } else if (action === "rm") {
        await sshRpc("docker_service_rm", { service }, hostId);
      } else {
        await sshRpc("docker_service_rollback", { service }, hostId);
      }
      await useDockerStore.getState().refreshSwarm(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, error: String(e) },
      }));
    } finally {
      patch(set, hostId, (h) => {
        const busy = { ...h.swarm.busyService };
        delete busy[service];
        return { ...h, swarm: { ...h.swarm, busyService: busy } };
      });
    }
  },

  stackAction: async (hostId, action, stack, composeFile) => {
    try {
      if (action === "deploy") {
        if (!composeFile) return;
        await sshRpc("docker_stack_deploy", { stack, composeFile }, hostId);
      } else {
        await sshRpc("docker_stack_rm", { stack }, hostId);
      }
      await useDockerStore.getState().refreshSwarm(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, error: String(e) },
      }));
    }
  },

  nodeAction: async (hostId, action, node) => {
    try {
      if (action === "promote") {
        await sshRpc("docker_node_promote", { node }, hostId);
      } else if (action === "demote") {
        await sshRpc("docker_node_demote", { node }, hostId);
      } else {
        const availability =
          action === "drain"
            ? "drain"
            : action === "pause"
              ? "pause"
              : "active";
        await sshRpc("docker_node_update", { node, availability }, hostId);
      }
      await useDockerStore.getState().refreshSwarm(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, error: String(e) },
      }));
    }
  },

  swarmInit: async (hostId, advertiseAddr) => {
    try {
      await sshRpc(
        "docker_swarm_init",
        advertiseAddr ? { advertiseAddr } : {},
        hostId,
      );
      await useDockerStore.getState().refreshSwarm(hostId);
      await useDockerStore.getState().refreshCapabilities(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, error: String(e) },
      }));
    }
  },

  swarmJoin: async (hostId, token, addr) => {
    // Token travels the token-authenticated RPC channel only, passed to
    // `docker swarm join --token` server-side. Never stored, never logged.
    try {
      await sshRpc("docker_swarm_join", { token, addr }, hostId);
      await useDockerStore.getState().refreshSwarm(hostId);
      await useDockerStore.getState().refreshCapabilities(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, error: String(e) },
      }));
    }
  },

  swarmLeave: async (hostId, force) => {
    try {
      await sshRpc("docker_swarm_leave", force ? { force: true } : {}, hostId);
      await useDockerStore.getState().refreshSwarm(hostId);
      await useDockerStore.getState().refreshCapabilities(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, error: String(e) },
      }));
    }
  },

  secretCreate: async (hostId, name, value) => {
    // Secret value travels the token-authenticated channel into
    // `docker secret create <name> -` stdin. Never stored, never logged.
    try {
      await sshRpc("docker_secret_create", { name, value }, hostId);
      await useDockerStore.getState().refreshSwarmSecrets(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, error: String(e) },
      }));
    }
  },

  secretRemove: async (hostId, name) => {
    try {
      await sshRpc("docker_secret_rm", { name }, hostId);
      await useDockerStore.getState().refreshSwarmSecrets(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, error: String(e) },
      }));
    }
  },

  configCreate: async (hostId, name, file) => {
    try {
      await sshRpc("docker_config_create", { name, file }, hostId);
      await useDockerStore.getState().refreshSwarmSecrets(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, error: String(e) },
      }));
    }
  },

  configRemove: async (hostId, name) => {
    try {
      await sshRpc("docker_config_rm", { name }, hostId);
      await useDockerStore.getState().refreshSwarmSecrets(hostId);
    } catch (e) {
      patch(set, hostId, (h) => ({
        ...h,
        swarm: { ...h.swarm, error: String(e) },
      }));
    }
  },

  refreshStackDrift: async (hostId, stack, composeFile) => {
    try {
      const [services, config] = await Promise.all([
        sshRpc<{ Image?: string }[]>(
          "docker_stack_services",
          { stack },
          hostId,
        ),
        sshRpc<{ config: string }>(
          "docker_compose_config",
          { files: [composeFile] },
          hostId,
        ),
      ]);
      const running = services
        .map((s) => String(s.Image ?? ""))
        .filter(Boolean)
        .sort();
      const desired = config.config
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("image:"))
        .map((l) => l.slice("image:".length).trim().replace(/["']/g, ""))
        .filter(Boolean)
        .sort();
      patch(set, hostId, (h) => ({
        ...h,
        swarm: {
          ...h.swarm,
          drift: { ...h.swarm.drift, [stack]: { running, desired } },
        },
      }));
    } catch {
      // best effort — drift row stays hidden
    }
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
