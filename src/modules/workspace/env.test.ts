import { describe, expect, it } from "vitest";
import {
  parseWorkspaceScopeKey,
  workspaceScopeKey,
  type WorkspaceEnv,
} from "./env";

describe("workspaceScopeKey", () => {
  it("keys local, wsl, and ssh distinctly", () => {
    expect(workspaceScopeKey({ kind: "local" })).toBe("local");
    expect(workspaceScopeKey({ kind: "wsl", distro: "Ubuntu" })).toBe(
      "wsl:Ubuntu",
    );
    expect(workspaceScopeKey({ kind: "ssh", hostId: "prod" })).toBe("ssh:prod");
  });
});

describe("parseWorkspaceScopeKey", () => {
  it("round-trips each env kind", () => {
    const envs: WorkspaceEnv[] = [
      { kind: "local" },
      { kind: "wsl", distro: "Ubuntu" },
      { kind: "ssh", hostId: "prod" },
    ];
    for (const env of envs) {
      expect(parseWorkspaceScopeKey(workspaceScopeKey(env))).toEqual(env);
    }
  });

  it("defaults unknown keys to local", () => {
    expect(parseWorkspaceScopeKey("local")).toEqual({ kind: "local" });
    expect(parseWorkspaceScopeKey("bogus")).toEqual({ kind: "local" });
  });
});
