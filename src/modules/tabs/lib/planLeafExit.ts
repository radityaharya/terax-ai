import type { WorkspaceEnv } from "@/modules/workspace";

export type LeafExitTarget = {
  /** Resolved tab env (use `tabEnv`); `local` for the default. */
  env: WorkspaceEnv;
  dockerExec?: unknown;
  zellijAttach?: unknown;
};

export type LeafExitPlan = "close" | "reconnect";

/**
 * What to do when a terminal's shell exits.
 *
 * - Local shells close their pane (the pre-existing behavior).
 * - Plain SSH and `docker exec` tabs are reconnectable: any exit keeps the
 *   tab and shows the "Connection lost — Reconnect" overlay.
 * - A `zellij attach` tab exits with code 0 when the user detaches on
 *   purpose, so that closes the tab like a local shell. A non-zero exit is
 *   a dropped connection, so the tab is kept for reattachment.
 */
export function planLeafExit(
  tab: LeafExitTarget,
  code: number,
): LeafExitPlan {
  const reconnectable =
    tab.env.kind === "ssh" || !!tab.dockerExec || !!tab.zellijAttach;
  if (!reconnectable) return "close";
  if (tab.zellijAttach && code === 0) return "close";
  return "reconnect";
}
