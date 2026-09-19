import type { WorkspaceEnv } from "@/modules/workspace";
import { describe, expect, it } from "vitest";
import { activeTabEnv, findActiveSpace, freshTabCwd } from "./activeSpace";
import type { SpaceMeta } from "./store";
import type { Tab } from "@/modules/tabs/lib/useTabs";

function space(over: Partial<SpaceMeta>): SpaceMeta {
  return {
    id: "s1",
    name: "Space",
    root: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function term(id: number, env?: WorkspaceEnv): Tab {
  return {
    id,
    kind: "terminal",
    spaceId: "s1",
    title: "shell",
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
    ...(env !== undefined && { env }),
  } as Tab;
}

describe("findActiveSpace", () => {
  it("returns the space matching activeId", () => {
    const spaces = [space({ id: "a" }), space({ id: "b" })];
    expect(findActiveSpace(spaces, "b")?.id).toBe("b");
  });

  it("falls back to the first space when activeId is null or unknown", () => {
    const spaces = [space({ id: "a" }), space({ id: "b" })];
    expect(findActiveSpace(spaces, null)?.id).toBe("a");
    expect(findActiveSpace(spaces, "missing")?.id).toBe("a");
  });

  it("returns null when there are no spaces", () => {
    expect(findActiveSpace([], "a")).toBeNull();
  });
});

describe("activeTabEnv", () => {
  it("restores the active tab's env", () => {
    const tabs = [
      term(1),
      term(2, { kind: "wsl", distro: "Ubuntu" }),
      term(3, { kind: "ssh", hostId: "prod" }),
    ];
    expect(activeTabEnv(tabs, 2)).toEqual({
      kind: "wsl",
      distro: "Ubuntu",
    });
    expect(activeTabEnv(tabs, 3)).toEqual({ kind: "ssh", hostId: "prod" });
    expect(activeTabEnv(tabs, 1)).toEqual({ kind: "local" });
  });

  it("falls back to the first tab when the active id is missing", () => {
    const tabs = [term(1, { kind: "wsl", distro: "Debian" })];
    expect(activeTabEnv(tabs, null)).toEqual({
      kind: "wsl",
      distro: "Debian",
    });
    expect(activeTabEnv(tabs, 999)).toEqual({
      kind: "wsl",
      distro: "Debian",
    });
  });

  it("defaults to local when nothing was restored", () => {
    expect(activeTabEnv([], null)).toEqual({ kind: "local" });
  });
});

describe("freshTabCwd", () => {
  const wsl: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };
  const ssh: WorkspaceEnv = { kind: "ssh", hostId: "prod" };
  const local: WorkspaceEnv = { kind: "local" };

  it("prefers the restored home for any env", () => {
    expect(freshTabCwd(wsl, "/home/aj", "C:/Users/me", "C:/Users/me")).toBe(
      "/home/aj",
    );
  });

  it("returns null for a WSL space when its home did not resolve", () => {
    expect(freshTabCwd(wsl, null, "C:/Users/me", "C:/Users/me")).toBeNull();
  });

  it("returns null for an SSH space when its home did not resolve", () => {
    expect(freshTabCwd(ssh, null, "C:/Users/me", "C:/Users/me")).toBeNull();
    expect(freshTabCwd(ssh, "/home/u", "C:/Users/me", "C:/Users/me")).toBe(
      "/home/u",
    );
  });

  it("falls back to the local launch cwd then home for a local space", () => {
    expect(freshTabCwd(local, null, "C:/work", "C:/Users/me")).toBe("C:/work");
    expect(freshTabCwd(local, null, null, "C:/Users/me")).toBe("C:/Users/me");
    expect(freshTabCwd(local, null, null, null)).toBeNull();
  });
});
