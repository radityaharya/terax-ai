import { native } from "@/modules/ai/lib/native";
import type { Tab } from "@/modules/tabs";
import { DEFAULT_SPACE_ID, tabEnv } from "@/modules/tabs/lib/useTabs";
import { isLeaf, type PaneNode } from "@/modules/terminal/lib/panes";
import type { WorkspaceEnv } from "@/modules/workspace";
import { useEffect, useRef } from "react";
import { activeTabEnv, freshTabCwd } from "./activeSpace";
import { freshTerminalTab, hydrateTabs } from "./serialize";
import { loadAll, type SpaceMeta, saveActiveId, saveSpacesList } from "./store";
import { useSpaces } from "./useSpaces";

type Params = {
  ready: boolean;
  launchCwd: string | null;
  home: string | null;
  allocId: () => number;
  replaceTabs: (tabs: Tab[], activeId: number) => void;
  markBooted: () => void;
  setActiveSpaceForNewTabs: (id: string) => void;
  adoptWorkspaceEnv: (env: WorkspaceEnv) => Promise<string | null>;
};

function isLocalCwd(cwd: string, tabs: Tab[]): boolean {
  // A cwd authorizes locally unless every terminal tab holding it lives on
  // an SSH host. SSH paths authorize on the remote agent, never in the
  // local registry. Tabs own their env now — no space lookup needed.
  const holders = tabs.filter(
    (t) =>
      t.kind === "terminal" &&
      (t.cwd === cwd || leafCwd(t.paneTree) === cwd),
  );
  if (holders.length === 0) return true;
  return holders.some((t) => tabEnv(t).kind !== "ssh");
}

function leafCwd(n: PaneNode): string | null {
  if (isLeaf(n)) return n.cwd ?? null;
  for (const c of n.children) {
    const found = leafCwd(c);
    if (found) return found;
  }
  return null;
}

function uniqueCwds(tabs: Tab[]): string[] {
  const set = new Set<string>();
  const walk = (n: PaneNode) => {
    if (isLeaf(n)) {
      if (n.cwd) set.add(n.cwd);
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const t of tabs) if (t.kind === "terminal") walk(t.paneTree);
  return [...set];
}

export function useSpacesBoot({
  ready,
  launchCwd,
  home,
  allocId,
  replaceTabs,
  markBooted,
  setActiveSpaceForNewTabs,
  adoptWorkspaceEnv,
}: Params) {
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    void (async () => {
      try {
        const { spaces, activeId, states } = await loadAll();

        if (spaces.length === 0) {
          const root = launchCwd ?? home ?? null;
          const meta: SpaceMeta = {
            id: DEFAULT_SPACE_ID,
            name: "Default",
            root,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await saveSpacesList([meta]);
          await saveActiveId(DEFAULT_SPACE_ID);
          setActiveSpaceForNewTabs(DEFAULT_SPACE_ID);
          useSpaces.getState().hydrate([meta], DEFAULT_SPACE_ID);
          return;
        }

        const restored: Tab[] = [];
        for (const space of spaces) {
          const st = states.get(space.id);
          if (!st) continue;
          restored.push(...hydrateTabs(st.tabs, space.id, allocId));
        }

        const active =
          activeId && spaces.some((s) => s.id === activeId)
            ? activeId
            : spaces[0].id;
        setActiveSpaceForNewTabs(active);

        // Env must come from the ACTIVE SPACE's own restored tab, never a
        // cross-space fallback — borrowing another space's tab here would
        // pick it as the final active tab below and leave the real active
        // space's tab strip empty (its own tab exists in `restored` but is
        // never selected).
        const inActiveBeforeFresh = restored.filter(
          (t) => t.spaceId === active,
        );
        const idxBeforeFresh = states.get(active)?.activeTabIndex ?? 0;
        const activeTabBeforeFresh =
          inActiveBeforeFresh[idxBeforeFresh] ??
          inActiveBeforeFresh[0] ??
          null;
        const env = activeTabEnv(
          inActiveBeforeFresh,
          activeTabBeforeFresh?.id ?? null,
        );
        const restoredHome = await adoptWorkspaceEnv(env);

        // Active space must never be empty, else its tab list shows nothing.
        if (inActiveBeforeFresh.length === 0) {
          const cwd = freshTabCwd(env, restoredHome, launchCwd, home);
          restored.push(freshTerminalTab(active, cwd, allocId));
        }

        // Only local/WSL cwds authorize locally. SSH paths belong to
        // the remote agent; authorizing them locally would reject with
        // "outside the authorized workspace" on every boot.
        await Promise.allSettled(
          uniqueCwds(restored)
            .filter((cwd) => isLocalCwd(cwd, restored))
            .map((cwd) => native.workspaceAuthorize(cwd)),
        );

        const initialActiveIndex: Record<string, number> = {};
        for (const [id, st] of states)
          initialActiveIndex[id] = st.activeTabIndex;
        useSpaces.getState().hydrate(spaces, active, initialActiveIndex);

        // Recomputed AFTER the fresh-tab push, so it always resolves to a
        // tab that actually belongs to the active space.
        const inActive = restored.filter((t) => t.spaceId === active);
        const idx = states.get(active)?.activeTabIndex ?? 0;
        const finalActive = inActive[idx] ?? inActive[0] ?? restored[0];
        replaceTabs(restored, finalActive.id);
      } catch (e) {
        console.error("[terax] spaces boot failed:", e);
      } finally {
        markBooted();
      }
    })();
  }, [
    ready,
    launchCwd,
    home,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  ]);
}
