import type { DockerContainer } from "./types";
import type { RowTone } from "../components/ResourceRow";

export type ContainerState =
  | "running"
  | "exited"
  | "paused"
  | "dead"
  | "unknown";

export function containerId(c: DockerContainer): string {
  const raw = (c.ID ?? c.Id ?? "") as string;
  return (
    raw.replace(/^sha256:/, "").slice(0, 12) || String(c.Names ?? c.Name ?? "?")
  );
}

export function containerName(c: DockerContainer): string {
  const raw = String(c.Names ?? c.Name ?? "");
  return raw.split(",")[0]?.replace(/^\//, "").trim() || containerId(c);
}

export function containerState(c: DockerContainer): ContainerState {
  const s = String(c.State ?? "").toLowerCase();
  if (s.includes("running")) return "running";
  if (s.includes("paused")) return "paused";
  if (s.includes("dead") || s.includes("removing")) return "dead";
  if (s.includes("exited") || s.includes("created")) return "exited";
  // `docker ps --format json` emits State + Status ("Up 2 hours").
  const status = String(c.Status ?? "").toLowerCase();
  if (status.startsWith("up")) return "running";
  if (status.startsWith("exited") || status.startsWith("created")) {
    return "exited";
  }
  if (status.includes("paused")) return "paused";
  return "unknown";
}

export function containerTone(state: ContainerState): RowTone {
  switch (state) {
    case "running":
      return "ok";
    case "paused":
      return "warn";
    case "dead":
      return "hot";
    default:
      return "idle";
  }
}
