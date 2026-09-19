import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WorkspaceEnv } from "@/modules/workspace";
import type { Tab } from "./useTabs";

type Result = {
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

function looksLocal(path: string): boolean {
  return (
    path.includes("\\") || /^[A-Za-z]:/.test(path) || path.startsWith("\\\\")
  );
}

export function useWorkspaceCwd(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
  env?: WorkspaceEnv,
  spaceRoot?: string | null,
): Result {
  const lastTerminalCwd = useRef<string | null>(null);

  useEffect(() => {
    if (activeTab?.kind === "terminal" && activeTab.cwd) {
      lastTerminalCwd.current = activeTab.cwd;
    }
  }, [activeTab]);

  // In SSH spaces a local fallback (home, stale cross-env cwd) must never
  // become the explorer root: the agent would reject it as outside the
  // remote workspace. Prefer the space root (remote home) instead.
  const sshSafe = useCallback(
    (cwd: string | null | undefined): string | null => {
      if (!cwd) return null;
      if (env?.kind === "ssh" && looksLocal(cwd)) return spaceRoot ?? null;
      return cwd;
    },
    [env, spaceRoot],
  );

  const explorerRoot = useMemo<string | null>(() => {
    if (activeTab?.kind === "terminal" && activeTab.cwd)
      return sshSafe(activeTab.cwd) ?? spaceRoot ?? home;
    if (lastTerminalCwd.current)
      return sshSafe(lastTerminalCwd.current) ?? spaceRoot ?? home;
    const anyTerm = tabs.find((t) => t.kind === "terminal" && t.cwd);
    if (anyTerm?.kind === "terminal" && anyTerm.cwd)
      return sshSafe(anyTerm.cwd) ?? spaceRoot ?? home;
    if (env?.kind === "ssh") return spaceRoot ?? home;
    return home;
  }, [activeTab, tabs, home, env, spaceRoot, sshSafe]);

  const inheritedCwdForNewTab = useCallback((): string | undefined => {
    if (activeTab?.kind === "terminal" && activeTab.cwd)
      return sshSafe(activeTab.cwd) ?? spaceRoot ?? home ?? undefined;
    // Editor tabs inherit the last terminal's cwd (or workspace home), not
    // the file's folder — opening a new terminal from a file shouldn't
    // hijack the user's working directory context.
    const last = sshSafe(lastTerminalCwd.current) ?? spaceRoot ?? home;
    return last ?? undefined;
  }, [activeTab, home, env, spaceRoot, sshSafe]);

  return { explorerRoot, inheritedCwdForNewTab };
}
