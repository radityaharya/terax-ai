import { beforeEach, describe, expect, it, vi } from "vitest";

const sshRpcMock = vi.hoisted(() => vi.fn());

vi.mock("@/modules/ai/lib/native", () => ({ sshRpc: sshRpcMock }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import { isStaleHandleError, MAX_HEALS, useDockerStore } from "./dockerStore";

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

describe("log follow self-heal", () => {
  it("respawns on no_handle and keeps following", async () => {
    const store = useDockerStore.getState();
    // Queue the spawn result BEFORE startLogFollow fires its async spawn.
    sshRpcMock.mockResolvedValueOnce({ handle: 1 });
    store.startLogFollow(HOST, "container", "web");
    await vi.waitFor(() => {
      expect(useDockerStore.getState().byHost[HOST]?.logFollows["container:web"]?.handle).toBe(1);
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
      expect(useDockerStore.getState().byHost[HOST]?.logFollows["container:web"]?.handle).toBe(2);
    });

    const follow = useDockerStore.getState().byHost[HOST]?.logFollows["container:web"];
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
      expect(useDockerStore.getState().byHost[HOST]?.logFollows["container:db"]?.handle).toBe(1);
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
        const f = useDockerStore.getState().byHost[HOST]?.logFollows["container:db"];
        expect(f?.handle).toBe(10 + i);
      });
    }
    // The healed lane's first poll now dies with no budget left.
    sshRpcMock.mockRejectedValueOnce(new Error("no background handle"));
    await store.pollLogFollow(HOST, "container:db");

    const follow = useDockerStore.getState().byHost[HOST]?.logFollows["container:db"];
    expect(follow?.phase).toBe("error");
    expect(follow?.healsLeft).toBe(0);
  });

  it("does not heal real errors", async () => {
    const store = useDockerStore.getState();
    sshRpcMock.mockResolvedValueOnce({ handle: 1 });
    store.startLogFollow(HOST, "container", "api");
    await vi.waitFor(() => {
      expect(useDockerStore.getState().byHost[HOST]?.logFollows["container:api"]?.handle).toBe(1);
    });

    sshRpcMock.mockRejectedValueOnce(new Error("docker_error: boom"));
    await store.pollLogFollow(HOST, "container:api");

    const follow = useDockerStore.getState().byHost[HOST]?.logFollows["container:api"];
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
      expect(useDockerStore.getState().byHost[HOST]?.pulls[jobId]?.handle).toBe(1);
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
    sshRpcMock.mockResolvedValueOnce(okPoll({ next_offset: 0, exited: true, exit_code: 0 }));

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
      expect(useDockerStore.getState().byHost[HOST]?.eventsFeed?.phase).toBe("streaming");
    });

    sshRpcMock.mockRejectedValueOnce(new Error("no_handle"));
    sshRpcMock.mockResolvedValueOnce({ handle: 2 });
    sshRpcMock.mockResolvedValue(okPoll({ bytes: "", next_offset: 0 }));

    await store.pollEventsFeed(HOST);
    await vi.waitFor(() => {
      expect(useDockerStore.getState().byHost[HOST]?.eventsFeed?.handle).toBe(2);
    });

    const feed = useDockerStore.getState().byHost[HOST]?.eventsFeed;
    expect(feed?.phase).toBe("streaming");
    expect(feed?.healsLeft).toBe(MAX_HEALS - 1);
  });
});
