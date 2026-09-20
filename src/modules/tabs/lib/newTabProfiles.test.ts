import { describe, expect, it } from "vitest";
import {
  groupForKind,
  groupProfiles,
  NEW_TAB_MRU_PREFIX,
  parseQuickConnect,
  quickConnectId,
  rankProfiles,
  recentProfiles,
  type NewTabProfile,
} from "./newTabProfiles";

function profile(
  id: string,
  title: string,
  overrides: Partial<NewTabProfile> = {},
): NewTabProfile {
  return {
    id: `${NEW_TAB_MRU_PREFIX}${id}`,
    kind: "tab",
    title,
    run: () => {},
    ...overrides,
  };
}

describe("parseQuickConnect", () => {
  it("parses user@host with an optional port", () => {
    expect(parseQuickConnect("deploy@example.com")).toEqual({
      user: "deploy",
      host: "example.com",
      port: null,
    });
    expect(parseQuickConnect("root@10.0.0.5:2222")).toEqual({
      user: "root",
      host: "10.0.0.5",
      port: 2222,
    });
    expect(parseQuickConnect("  ops@box.local  ")).toEqual({
      user: "ops",
      host: "box.local",
      port: null,
    });
  });

  // Without a user we would have to invent a login name, and a saved host
  // already covers the "just type the hostname" case.
  it("refuses a bare host, a bare word, or a user without a real host", () => {
    expect(parseQuickConnect("example.com")).toBeNull();
    expect(parseQuickConnect("contabo")).toBeNull();
    expect(parseQuickConnect("deploy@")).toBeNull();
    expect(parseQuickConnect("@example.com")).toBeNull();
    expect(parseQuickConnect("deploy@intranet")).toBeNull();
    expect(parseQuickConnect("")).toBeNull();
  });

  it("accepts localhost and rejects an out-of-range port", () => {
    expect(parseQuickConnect("me@localhost")).toEqual({
      user: "me",
      host: "localhost",
      port: null,
    });
    expect(parseQuickConnect("me@host.dev:70000")).toBeNull();
    expect(parseQuickConnect("me@host.dev:0")).toBeNull();
  });
});

describe("quickConnectId", () => {
  it("namespaces the id and normalises the port", () => {
    expect(quickConnectId({ user: "a", host: "b.dev", port: null })).toBe(
      `${NEW_TAB_MRU_PREFIX}quick:a@b.dev:22`,
    );
    expect(quickConnectId({ user: "a", host: "b.dev", port: 2200 })).toBe(
      `${NEW_TAB_MRU_PREFIX}quick:a@b.dev:2200`,
    );
  });
});

describe("rankProfiles", () => {
  const terminal = profile("terminal", "Terminal", { detail: "Ctrl T" });
  const host = profile("ssh:ts", "ts-contabo", {
    kind: "ssh",
    detail: "radityaharya@100.101.101.101",
    keywords: ["ssh", "connect"],
  });

  it("leaves the order alone when nothing is typed", () => {
    expect(rankProfiles([terminal, host], "   ", {})).toEqual([terminal, host]);
  });

  it("keeps only fuzzy matches", () => {
    expect(rankProfiles([terminal, host], "term", {})).toEqual([terminal]);
    expect(rankProfiles([terminal, host], "zzz", {})).toEqual([]);
  });

  it("matches on the detail and hidden keywords too", () => {
    // "raditya" only appears in the host's detail line.
    expect(rankProfiles([terminal, host], "raditya", {})).toEqual([host]);
    expect(rankProfiles([terminal, host], "ssh", {})).toEqual([host]);
  });

  it("breaks equal scores by recency", () => {
    const a = profile("a", "alpha");
    const b = profile("b", "alpha");
    expect(rankProfiles([a, b], "alpha", {})).toEqual([a, b]);
    expect(rankProfiles([a, b], "alpha", { [b.id]: 123 })).toEqual([b, a]);
  });
});

describe("recentProfiles", () => {
  const terminal = profile("terminal", "Terminal");
  const host = profile("ssh:ts", "ts-contabo", { kind: "ssh" });

  it("drops profiles that were never launched", () => {
    expect(recentProfiles([terminal, host], {})).toEqual([]);
  });

  it("returns newest first and respects the limit", () => {
    const mru = { [host.id]: 200, [terminal.id]: 100 };
    expect(recentProfiles([terminal, host], mru)).toEqual([host, terminal]);
    expect(recentProfiles([terminal, host], mru, 1)).toEqual([host]);
  });
});

describe("groupProfiles", () => {
  it("keeps the declared group order and drops empty groups", () => {
    const rows = [
      profile("quick", "Connect to a@b.dev", { kind: "quick" }),
      profile("ssh:ts", "ts-contabo", { kind: "ssh" }),
      profile("terminal", "Terminal"),
      profile("zellij:ts", "ts-contabo", { kind: "zellij" }),
    ];
    expect(groupProfiles(rows).map((g) => g.group)).toEqual([
      "Connect",
      "Tabs",
      "SSH hosts",
      "Zellij sessions",
    ]);
  });

  it("maps every kind to a known group", () => {
    for (const kind of ["quick", "tab", "ssh", "docker", "zellij"] as const) {
      expect(groupProfiles([profile("x", "X", { kind })])).toHaveLength(1);
      expect(groupForKind(kind)).toBeTruthy();
    }
  });
});
