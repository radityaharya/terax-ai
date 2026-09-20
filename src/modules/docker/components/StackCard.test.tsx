import { describe, expect, it } from "vitest";
import { groupTasksByService, taskIsLive, taskServiceName } from "./StackCard";

describe("groupTasksByService", () => {
  it("strips the slot and task suffix from stack task names", () => {
    const groups = groupTasksByService([
      { Name: "arena_arena-backend.1.abc123", CurrentState: "Running", taskHealthy: true },
      { Name: "arena_arena-backend.2.def456", CurrentState: "Running", taskHealthy: true },
      { Name: "arena_arena-caddy.1.ghi789", CurrentState: "Failed", Error: "boom", taskHealthy: false },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.service).toBe("arena_arena-backend");
    expect(groups[0]?.tasks).toHaveLength(2);
    expect(groups[1]?.service).toBe("arena_arena-caddy");
  });

  it("keeps unparseable names in their own group", () => {
    const groups = groupTasksByService([
      { Name: "weird", CurrentState: "Pending" },
      {},
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.tasks).toHaveLength(1);
    expect(groups[1]?.service).toBe("?");
  });

  it("returns an empty list for no tasks", () => {
    expect(groupTasksByService([])).toEqual([]);
  });
});

describe("taskIsLive", () => {
  it("treats DesiredState Shutdown as retired history", () => {
    expect(taskIsLive({ DesiredState: "Running" })).toBe(true);
    expect(taskIsLive({ DesiredState: "running" })).toBe(true);
    expect(taskIsLive({ DesiredState: "Shutdown" })).toBe(false);
    expect(taskIsLive({ DesiredState: "shutdown" })).toBe(false);
  });

  it("keeps tasks with a missing DesiredState live", () => {
    expect(taskIsLive({})).toBe(true);
    expect(taskIsLive({ DesiredState: "" })).toBe(true);
  });
});

describe("taskServiceName", () => {
  it("drops the slot and task id suffix", () => {
    expect(
      taskServiceName({
        Name: "arena_arena-backend.1.y9q2xiqertc2crbkvdmqkqc19",
      }),
    ).toBe("arena_arena-backend");
  });

  it("handles missing names and degenerate shapes", () => {
    expect(taskServiceName({})).toBe("?");
    expect(taskServiceName({ Name: "   " })).toBe("?");
    expect(taskServiceName({ Name: "solo" })).toBe("solo");
    expect(taskServiceName({ Name: "svc.1" })).toBe("svc.1");
  });
});
