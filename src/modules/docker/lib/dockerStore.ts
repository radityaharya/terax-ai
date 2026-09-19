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
  };
}

type State = {
  byHost: Record<string, HostDockerState>;
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
};

function patch(
  set: (f: (s: State) => State) => void,
  hostId: string,
  f: (h: HostDockerState) => HostDockerState,
) {
  set((s) => ({
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

export const useDockerStore = create<State>((set) => ({
  byHost: {},

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
}));

export function hostDocker(hostId: string | null): HostDockerState {
  if (!hostId) return emptyHost();
  return useDockerStore.getState().byHost[hostId] ?? emptyHost();
}
