import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type {
  HostKeyStatus,
  ImportedHost,
  ProbeOutcome,
  ScannedKey,
  SshHost,
  SshHostInput,
} from "./types";

export type ConnectionStatus =
  | { state: "unknown" }
  | { state: "checking" }
  | { state: "online"; home: string }
  | { state: "needs-auth"; message: string; next: string }
  | { state: "host-key"; message: string }
  | { state: "offline"; message: string };

type State = {
  hosts: SshHost[];
  imported: ImportedHost[];
  importedLoaded: boolean;
  loading: boolean;
  error: string | null;
  connections: Record<string, ConnectionStatus>;
  setHosts: (hosts: SshHost[]) => void;
  setConnection: (id: string, status: ConnectionStatus) => void;
};

export const useHostStore = create<State>((set) => ({
  hosts: [],
  imported: [],
  importedLoaded: false,
  loading: false,
  error: null,
  connections: {},
  setHosts: (hosts) => set({ hosts }),
  setConnection: (id, status) =>
    set((s) => ({ connections: { ...s.connections, [id]: status } })),
}));

export async function refreshHosts(): Promise<SshHost[]> {
  useHostStore.setState({ loading: true, error: null });
  try {
    const hosts = await invoke<SshHost[]>("ssh_list_hosts");
    useHostStore.setState({ hosts, loading: false });
    return hosts;
  } catch (e) {
    useHostStore.setState({
      hosts: [],
      loading: false,
      error: String(e),
    });
    return [];
  }
}

export async function refreshImported(): Promise<ImportedHost[]> {
  try {
    const imported = await invoke<ImportedHost[]>("ssh_import_config");
    useHostStore.setState({ imported, importedLoaded: true });
    return imported;
  } catch {
    useHostStore.setState({ imported: [], importedLoaded: true });
    return [];
  }
}

export async function saveHost(input: SshHostInput): Promise<SshHost> {
  const host = await invoke<SshHost>("ssh_save_host", { input });
  useHostStore.setState((s) => ({
    hosts: [...s.hosts.filter((h) => h.id !== host.id), host].sort((a, b) =>
      a.alias.toLowerCase().localeCompare(b.alias.toLowerCase()),
    ),
  }));
  return host;
}

export async function deleteHost(id: string): Promise<void> {
  await invoke("ssh_delete_host", { id });
  // Keep-alive model: drop the RPC channel too, or the daemon holds a dead
  // host's ssh process forever.
  await invoke("ssh_disconnect", { hostId: id }).catch(() => {});
  useHostStore.setState((s) => ({
    hosts: s.hosts.filter((h) => h.id !== id),
  }));
}

export async function bindHostSpace(
  id: string,
  spaceId: string | null,
): Promise<void> {
  await invoke("ssh_bind_space", { id, spaceId });
  useHostStore.setState((s) => ({
    hosts: s.hosts.map((h) =>
      h.id === id ? { ...h, boundSpaceId: spaceId } : h,
    ),
  }));
}

/** Non-interactive auth probe. Resolves to a ConnectionStatus the panel renders. */
export async function probeHost(host: SshHost): Promise<ConnectionStatus> {
  const { setConnection } = useHostStore.getState();
  setConnection(host.id, { state: "checking" });
  try {
    const keyStatus = await invoke<HostKeyStatus>("ssh_host_key_status", {
      hostname: host.hostname,
      port: host.port,
    }).catch(() => ({ known: true, lines: [] }) as HostKeyStatus);
    if (!keyStatus.known) {
      const status: ConnectionStatus = {
        state: "host-key",
        message: `Unknown host key for ${host.hostname}`,
      };
      setConnection(host.id, status);
      return status;
    }
    const outcome = await invoke<ProbeOutcome>("ssh_probe_auth", {
      id: host.id,
    });
    if (outcome.ok) {
      const home = await invoke<string>("ssh_home_for", { id: host.id });
      const status: ConnectionStatus = { state: "online", home };
      setConnection(host.id, status);
      return status;
    }
    const status: ConnectionStatus = {
      state: "needs-auth",
      message: outcome.message ?? "Authentication required",
      next: outcome.next ?? "password",
    };
    setConnection(host.id, status);
    return status;
  } catch (e) {
    const status: ConnectionStatus = { state: "offline", message: String(e) };
    setConnection(host.id, status);
    return status;
  }
}

export async function scanKeys(
  hostname: string,
  port: number,
): Promise<ScannedKey[]> {
  return invoke<ScannedKey[]>("ssh_scan_host_keys", { hostname, port });
}
