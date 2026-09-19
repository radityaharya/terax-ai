import type { Tab } from "@/modules/tabs/lib/useTabs";
import { tabEnv } from "@/modules/tabs/lib/useTabs";
import type { WorkspaceEnv } from "@/modules/workspace";
import type { SpaceMeta } from "./store";

export function findActiveSpace(
  spaces: SpaceMeta[],
  activeId: string | null,
): SpaceMeta | null {
  if (activeId) {
    const found = spaces.find((s) => s.id === activeId);
    if (found) return found;
  }
  return spaces[0] ?? null;
}

/**
 * Boot env comes from the restored ACTIVE TAB, not the space: tabs own
 * env now. Falls back to local when nothing was restored.
 */
export function activeTabEnv(tabs: Tab[], activeTabId: number | null): WorkspaceEnv {
  const tab =
    (activeTabId !== null ? tabs.find((t) => t.id === activeTabId) : null) ??
    tabs[0];
  return tab ? tabEnv(tab) : { kind: "local" };
}

// A WSL or SSH tab falls back to null, not the local cwd, so its first tab
// opens at the remote home instead of a local path.
export function freshTabCwd(
  env: WorkspaceEnv,
  restoredHome: string | null,
  launchCwd: string | null,
  home: string | null,
): string | null {
  return restoredHome ?? (env.kind === "local" ? (launchCwd ?? home) : null);
}
