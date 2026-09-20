import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => core);

import {
  bindHostSpace,
  deleteHost,
  probeHost,
  refreshHosts,
  refreshImported,
  saveHost,
  useHostStore,
} from "./hostStore";
import type { SshHost } from "./types";

function host(over: Partial<SshHost> = {}): SshHost {
  return {
    id: "prod",
    alias: "prod",
    user: "deploy",
    hostname: "10.0.0.5",
    port: 22,
    agentForward: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

beforeEach(() => {
  core.invoke.mockReset();
  useHostStore.setState({
    hosts: [],
    imported: [],
    importedLoaded: false,
    loading: false,
    error: null,
    connections: {},
  });
});

describe("refreshHosts", () => {
  it("loads and stores hosts", async () => {
    core.invoke.mockResolvedValue([host()]);
    const hosts = await refreshHosts();
    expect(hosts).toHaveLength(1);
    expect(useHostStore.getState().hosts).toHaveLength(1);
    expect(core.invoke).toHaveBeenCalledWith("ssh_list_hosts");
  });

  it("records errors without throwing", async () => {
    core.invoke.mockRejectedValue(new Error("nope"));
    const hosts = await refreshHosts();
    expect(hosts).toEqual([]);
    expect(useHostStore.getState().error).toContain("nope");
  });
});

describe("saveHost / deleteHost", () => {
  it("upserts saved hosts sorted by alias", async () => {
    useHostStore.setState({ hosts: [host({ id: "z", alias: "zeta" })] });
    core.invoke.mockResolvedValue(host({ id: "a", alias: "alpha" }));
    await saveHost({
      alias: "alpha",
      user: "u",
      hostname: "h",
      port: 22,
    });
    const aliases = useHostStore.getState().hosts.map((h) => h.alias);
    expect(aliases).toEqual(["alpha", "zeta"]);
  });

  it("removes deleted hosts", async () => {
    useHostStore.setState({ hosts: [host()] });
    core.invoke.mockResolvedValue(undefined);
    await deleteHost("prod");
    expect(useHostStore.getState().hosts).toEqual([]);
  });
});

describe("bindHostSpace", () => {
  it("updates the bound space id", async () => {
    useHostStore.setState({ hosts: [host()] });
    core.invoke.mockResolvedValue(undefined);
    await bindHostSpace("prod", "sp-1");
    expect(useHostStore.getState().hosts[0]?.boundSpaceId).toBe("sp-1");
  });
});

describe("probeHost", () => {
  it("marks online and resolves home on success", async () => {
    core.invoke.mockImplementation((cmd: string) => {
      if (cmd === "ssh_host_key_status")
        return Promise.resolve({ known: true, lines: [] });
      if (cmd === "ssh_probe_host")
        return Promise.resolve({ ok: true, home: "/home/deploy" });
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const status = await probeHost(host());
    expect(status).toEqual({ state: "online", home: "/home/deploy" });
    expect(useHostStore.getState().connections.prod).toEqual(status);
  });

  it("surfaces host-key state before probing auth", async () => {
    core.invoke.mockImplementation((cmd: string) => {
      if (cmd === "ssh_host_key_status")
        return Promise.resolve({ known: false, lines: [] });
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const status = await probeHost(host());
    expect(status.state).toBe("host-key");
  });

  it("surfaces needs-auth with the probe hint", async () => {
    core.invoke.mockImplementation((cmd: string) => {
      if (cmd === "ssh_host_key_status")
        return Promise.resolve({ known: true, lines: [] });
      if (cmd === "ssh_probe_host")
        return Promise.resolve({ ok: false, message: "denied", next: "password" });
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const status = await probeHost(host());
    expect(status).toEqual({
      state: "needs-auth",
      message: "denied",
      next: "password",
    });
  });
});

describe("refreshImported", () => {
  it("loads ssh-config entries", async () => {
    core.invoke.mockResolvedValue([{ alias: "db" }]);
    const imported = await refreshImported();
    expect(imported).toHaveLength(1);
    expect(useHostStore.getState().importedLoaded).toBe(true);
  });

  it("marks the ssh scope key distinctly", async () => {
    const { workspaceScopeKey } = await import("@/modules/workspace");
    expect(workspaceScopeKey({ kind: "ssh", hostId: "prod" })).toBe("ssh:prod");
  });
});
