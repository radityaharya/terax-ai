import { beforeEach, describe, expect, it, vi } from "vitest";

const sshRpcMock = vi.hoisted(() => vi.fn());

vi.mock("@/modules/ai/lib/native", () => ({ sshRpc: sshRpcMock }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import {
  isStaleHandleError,
  MAX_HEALS,
  normalizeStatsSample,
  useDockerStore,
} from "./dockerStore";

const HOST = "test-host";

function okPoll(over: Record<string, unknown> = {}) {
  return {
    bytes: "",
    next_offset: 0,
    dropped: 0,
    exited: false,
    exit_code: null,
    ...over,
  };
}

beforeEach(() => {
  sshRpcMock.mockReset();
  useDockerStore.setState((s) => ({ ...s, byHost: {} }));
});

describe("isStaleHandleError", () => {
  it("matches the agent code and legacy message", () => {
    expect(isStaleHandleError("no_handle")).toBe(true);
    expect(isStaleHandleError("no background handle")).toBe(true);
    expect(isStaleHandleError(new Error("no_handle"))).toBe(true);
  });

  it("rejects real errors", () => {
    expect(isStaleHandleError("docker_error: boom")).toBe(false);
    expect(isStaleHandleError("remote request timed out")).toBe(false);
  });
});

describe("normalizeStatsSample", () => {
  it("maps PascalCase daemon keys to the camelCase wire shape", () => {
    const s = normalizeStatsSample({
      BlockIO: "27.5MB / 295kB",
      CPUPerc: "0.00%",
      Container:
        "e04ff5b92e5597db9edc39c61d11f90289c97be5a481348fe439082ad3495406",
      ID: "e04ff5b92e55",
      MemPerc: "0.10%",
      MemUsage: "12.19MiB / 11.68GiB",
      Name: "chat-chroma",
      NetIO: "13.9kB / 126B",
      PIDs: "10",
    });
    expect(s).toMatchObject({
      container:
        "e04ff5b92e5597db9edc39c61d11f90289c97be5a481348fe439082ad3495406",
      id: "e04ff5b92e55",
      name: "chat-chroma",
      cpuPerc: "0.00%",
      memUsage: "12.19MiB / 11.68GiB",
      memPerc: "0.10%",
      netIO: "13.9kB / 126B",
      blockIO: "27.5MB / 295kB",
      pids: "10",
    });
  });

  it("passes through camelCase samples untouched", () => {
    const s = normalizeStatsSample({
      container: "abc123",
      name: "web",
      cpuPerc: "12.88%",
      memUsage: "165.4MiB / 11.68GiB",
      memPerc: "1.38%",
      netIO: "5.63MB / 17.8kB",
      blockIO: "771MB / 4.06MB",
      pids: "12",
    });
    expect(s).toMatchObject({
      container: "abc123",
      id: "abc123",
      name: "web",
      cpuPerc: "12.88%",
      memUsage: "165.4MiB / 11.68GiB",
    });
  });

  it("stores refreshStats samples under every lookup key the panel uses", async () => {
    const store = useDockerStore.getState();
    sshRpcMock.mockResolvedValueOnce([
      {
        BlockIO: "27.5MB / 295kB",
        CPUPerc: "0.00%",
        Container:
          "e04ff5b92e5597db9edc39c61d11f90289c97be5a481348fe439082ad3495406",
        ID: "e04ff5b92e55",
        MemPerc: "0.10%",
        MemUsage: "12.19MiB / 11.68GiB",
        Name: "chat-chroma",
        NetIO: "13.9kB / 126B",
        PIDs: "10",
      },
    ]);
    await store.refreshStats(HOST);
    const stats = useDockerStore.getState().byHost[HOST]?.stats ?? {};
    // Panel looks up by 12-char list id; the daemon keys by full id/name.
    expect(stats["e04ff5b92e55"]?.cpuPerc).toBe("0.00%");
    expect(stats["chat-chroma"]?.memUsage).toBe("12.19MiB / 11.68GiB");
    expect(stats["e04ff5b92e5597db9edc39c61d11f90289c97be5a481348fe439082ad3495406"]?.netIO).toBe(
      "13.9kB / 126B",
    );
    expect(
      useDockerStore.getState().byHost[HOST]?.statsError,
    ).toBeNull();
  });

  it("records refreshStats failures instead of dropping them silently", async () => {
    const store = useDockerStore.getState();
    sshRpcMock.mockRejectedValueOnce(new Error("daemon down"));
    await store.refreshStats(HOST);
    expect(useDockerStore.getState().byHost[HOST]?.statsError).toContain(
      "daemon down",
    );
  });
});

describe("log follow self-heal", () => {
  it("respawns on no_handle and keeps following", async () => {
    const store = useDockerStore.getState();
    // Queue the spawn result BEFORE startLogFollow fires its async spawn.
    sshRpcMock.mockResolvedValueOnce({ handle: 1 });
    store.startLogFollow(HOST, "container", "web");
    await vi.waitFor(() => {
      expect(
        useDockerStore.getState().byHost[HOST]?.logFollows["container:web"]
          ?.handle,
      ).toBe(1);
    });

    // Poll fails with a dead lane; respawn returns handle 2, then an
    // empty clean poll ends the drain loop. mockResolvedValueOnce (not
    // the sticky mockResolvedValue) so leftover queue state can't leak
    // an undefined into a later poll's `res`.
    sshRpcMock.mockRejectedValueOnce(new Error("no_handle"));
    sshRpcMock.mockResolvedValueOnce({ handle: 2 });
    sshRpcMock.mockResolvedValueOnce(okPoll({ next_offset: 0 }));

    await store.pollLogFollow(HOST, "container:web");
    // Respawn chains spawn -> poll internally; settle the chain.
    await vi.waitFor(() => {
      expect(
        useDockerStore.getState().byHost[HOST]?.logFollows["container:web"]
          ?.handle,
      ).toBe(2);
    });

    const follow =
      useDockerStore.getState().byHost[HOST]?.logFollows["container:web"];
    expect(follow?.phase).toBe("following");
    expect(follow?.healsLeft).toBe(MAX_HEALS - 1);
    expect(sshRpcMock).toHaveBeenCalledWith(
      "docker_logs_spawn",
      expect.objectContaining({ container: "web" }),
      HOST,
    );
  });

  it("parks in error after the budget is spent", async () => {
    const store = useDockerStore.getState();
    sshRpcMock.mockResolvedValueOnce({ handle: 1 });
    store.startLogFollow(HOST, "container", "db");
    await vi.waitFor(() => {
      expect(
        useDockerStore.getState().byHost[HOST]?.logFollows["container:db"]
          ?.handle,
      ).toBe(1);
    });

    // Every poll dies but every spawn succeeds: MAX_HEALS respawns
    // (handles 10..), then the error must surface. Each respawn's first
    // poll needs a clean (empty) result so the inner chain settles.
    for (let i = 0; i < MAX_HEALS; i++) {
      sshRpcMock.mockRejectedValueOnce(new Error("no background handle"));
      sshRpcMock.mockResolvedValueOnce({ handle: 10 + i });
      sshRpcMock.mockResolvedValueOnce(okPoll({ next_offset: 0 }));
      await store.pollLogFollow(HOST, "container:db");
      await vi.waitFor(() => {
        const f =
          useDockerStore.getState().byHost[HOST]?.logFollows["container:db"];
        expect(f?.handle).toBe(10 + i);
      });
    }
    // The healed lane's first poll now dies with no budget left.
    sshRpcMock.mockRejectedValueOnce(new Error("no background handle"));
    await store.pollLogFollow(HOST, "container:db");

    const follow =
      useDockerStore.getState().byHost[HOST]?.logFollows["container:db"];
    expect(follow?.phase).toBe("error");
    expect(follow?.healsLeft).toBe(0);
  });

  it("does not heal real errors", async () => {
    const store = useDockerStore.getState();
    sshRpcMock.mockResolvedValueOnce({ handle: 1 });
    store.startLogFollow(HOST, "container", "api");
    await vi.waitFor(() => {
      expect(
        useDockerStore.getState().byHost[HOST]?.logFollows["container:api"]
          ?.handle,
      ).toBe(1);
    });

    sshRpcMock.mockRejectedValueOnce(new Error("docker_error: boom"));
    await store.pollLogFollow(HOST, "container:api");

    const follow =
      useDockerStore.getState().byHost[HOST]?.logFollows["container:api"];
    expect(follow?.phase).toBe("error");
    expect(follow?.error).toContain("boom");
    expect(follow?.healsLeft).toBe(MAX_HEALS);
    // Only the initial spawn for this container may exist — no heal spawn.
    const spawns = sshRpcMock.mock.calls.filter(
      ([m, p]) =>
        m === "docker_logs_spawn" &&
        (p as Record<string, unknown>).container === "api",
    );
    expect(spawns).toHaveLength(1);
  });
});

describe("pull self-heal", () => {
  it("respawns the pull on a dead lane", async () => {
    const store = useDockerStore.getState();
    // Queue the spawn result BEFORE startPull fires its async spawn, and
    // drain startPull's own trailing pollPull with an empty clean chunk so
    // no leftover queue state leaks into the heal sequence below.
    sshRpcMock.mockResolvedValueOnce({ handle: 1 });
    sshRpcMock.mockResolvedValueOnce(okPoll({ next_offset: 0 }));
    const jobId = store.startPull(HOST, "img:latest");
    await vi.waitFor(() => {
      expect(useDockerStore.getState().byHost[HOST]?.pulls[jobId]?.handle).toBe(
        1,
      );
    });
    // Let startPull's internal pollPull consume the drained chunk first.
    await vi.waitFor(() => {
      expect(
        sshRpcMock.mock.calls.filter(([m]) => m === "docker_events_poll"),
      ).toHaveLength(1);
    });

    // Heal chain: poll dies -> respawn (handle 2) -> its poll exits 0.
    // NOTE: mockRejectedValueOnce/mockResolvedValueOnce share ONE queue
    // per mock (reject entries don't consume resolve entries). Queued in
    // strict call order: poll#1 rejects, spawn resolves, poll#2 resolves.
    sshRpcMock.mockRejectedValueOnce(new Error("no_handle"));
    sshRpcMock.mockResolvedValueOnce({ handle: 2 });
    sshRpcMock.mockResolvedValueOnce(
      okPoll({ next_offset: 0, exited: true, exit_code: 0 }),
    );

    await store.pollPull(HOST, jobId);
    await vi.waitFor(() => {
      const j = useDockerStore.getState().byHost[HOST]?.pulls[jobId];
      if (j?.handle !== 2 || j?.phase !== "done") {
        throw new Error(
          `waiting for heal (handle=${j?.handle} phase=${j?.phase} error=${j?.error} calls=${JSON.stringify(sshRpcMock.mock.calls.map((c) => c[0]))})`,
        );
      }
    });

    const job = useDockerStore.getState().byHost[HOST]?.pulls[jobId];
    expect(job?.phase).toBe("done");
    expect(sshRpcMock).toHaveBeenCalledWith(
      "docker_pull",
      expect.objectContaining({ reference: "img:latest" }),
      HOST,
    );
  });
});

describe("events feed self-heal", () => {
  it("respawns the feed on a dead lane", async () => {
    const store = useDockerStore.getState();
    // Queue spawn + its immediate poll BEFORE startEventsFeed fires.
    sshRpcMock.mockResolvedValueOnce({ handle: 1 });
    sshRpcMock.mockResolvedValueOnce(okPoll({ bytes: "", next_offset: 0 }));
    await store.startEventsFeed(HOST);
    await vi.waitFor(() => {
      expect(useDockerStore.getState().byHost[HOST]?.eventsFeed?.phase).toBe(
        "streaming",
      );
    });

    sshRpcMock.mockRejectedValueOnce(new Error("no_handle"));
    sshRpcMock.mockResolvedValueOnce({ handle: 2 });
    sshRpcMock.mockResolvedValue(okPoll({ bytes: "", next_offset: 0 }));

    await store.pollEventsFeed(HOST);
    await vi.waitFor(() => {
      expect(useDockerStore.getState().byHost[HOST]?.eventsFeed?.handle).toBe(
        2,
      );
    });

    const feed = useDockerStore.getState().byHost[HOST]?.eventsFeed;
    expect(feed?.phase).toBe("streaming");
    expect(feed?.healsLeft).toBe(MAX_HEALS - 1);
  });
});

describe("compose profiles + files", () => {
  const FILES = [
    "/home/u/docker-services/OmniRoute/docker-compose.yml",
    "/home/u/docker-services/OmniRoute/docker-compose.override.yml",
  ];

  async function seedProject() {
    const store = useDockerStore.getState();
    sshRpcMock.mockResolvedValueOnce([]); // docker_compose_ps
    sshRpcMock.mockResolvedValueOnce({
      profiles: ["base", "web"],
    }); // docker_compose_profiles
    await store.refreshCompose(HOST, "omniroute", FILES, "/home/u/docker-services/OmniRoute");
    await vi.waitFor(() => {
      expect(
        useDockerStore.getState().byHost[HOST]?.compose["omniroute"]?.profiles,
      ).toEqual(["base", "web"]);
    });
  }

  it("fetches declared profiles and keeps them on the project", async () => {
    await seedProject();
    const p = useDockerStore.getState().byHost[HOST]?.compose["omniroute"];
    expect(p?.profiles).toEqual(["base", "web"]);
    expect(p?.activeProfiles).toEqual([]);
  });

  it("prunes selected profiles that disappear from the file", async () => {
    await seedProject();
    const store = useDockerStore.getState();
    store.setComposeProfiles(HOST, "omniroute", ["base", "web"]);
    expect(
      useDockerStore.getState().byHost[HOST]?.compose["omniroute"]
        ?.activeProfiles,
    ).toEqual(["base", "web"]);

    // A later edit to the file drops `web`.
    sshRpcMock.mockResolvedValueOnce([]); // ps
    sshRpcMock.mockResolvedValueOnce({ profiles: ["base"] });
    await store.refreshCompose(HOST, "omniroute", FILES, "/home/u/docker-services/OmniRoute");
    await vi.waitFor(() => {
      expect(
        useDockerStore.getState().byHost[HOST]?.compose["omniroute"]
          ?.activeProfiles,
      ).toEqual(["base"]);
    });
  });

  it("passes selected profiles on up/restart/pull but not down", async () => {
    await seedProject();
    useDockerStore.getState().setComposeProfiles(HOST, "omniroute", ["base"]);
    expect(
      useDockerStore.getState().byHost[HOST]?.compose.omniroute
        ?.activeProfiles,
    ).toEqual(["base"]);

    const methodFor = {
      up: "docker_compose_up",
      restart: "docker_compose_restart",
      pull: "docker_compose_pull",
    } as const;
    for (const action of ["up", "restart", "pull"] as const) {
      sshRpcMock.mockReset();
      sshRpcMock.mockResolvedValue([]);
      await useDockerStore.getState().composeAction(HOST, "omniroute", action);
      const call = sshRpcMock.mock.calls.find(
        ([m]) => m === methodFor[action],
      );
      expect(call?.[1]).toMatchObject({ profiles: ["base"] });
    }

    sshRpcMock.mockReset();
    sshRpcMock.mockResolvedValue([]);
    await useDockerStore.getState().composeAction(HOST, "omniroute", "down");
    const downCall = sshRpcMock.mock.calls.find(
      ([m]) => m === "docker_compose_down",
    );
    // `down` resolves the running project; --profile there errors for
    // services that were never created.
    expect(downCall?.[1]).not.toHaveProperty("profiles");
  });

  it("honours a files override from the multi-file picker", async () => {
    await seedProject();
    sshRpcMock.mockReset();
    sshRpcMock.mockResolvedValue([]);
    const onlyFirst = [FILES[0]];
    await useDockerStore
      .getState()
      .composeAction(HOST, "omniroute", "up", { files: onlyFirst });
    const call = sshRpcMock.mock.calls.find(
      ([m]) => m === "docker_compose_up",
    );
    expect(call?.[1]).toMatchObject({ files: onlyFirst });
  });

  it("refuses to run compose with an empty file selection", async () => {
    await seedProject();
    sshRpcMock.mockReset();
    sshRpcMock.mockResolvedValue([]);
    await useDockerStore
      .getState()
      .composeAction(HOST, "omniroute", "up", { files: [] });
    // Falls back to the registered files rather than running bare compose.
    const call = sshRpcMock.mock.calls.find(
      ([m]) => m === "docker_compose_up",
    );
    expect(call?.[1]).toMatchObject({ files: FILES });
  });
});
