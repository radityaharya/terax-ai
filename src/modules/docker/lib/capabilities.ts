import type { DockerCapabilities, DockerDaemonState } from "./types";

/** One-line daemon summary for the panel header pill. */
export function daemonLabel(daemon: DockerDaemonState): string {
  switch (daemon.status) {
    case "ready":
      return `Docker ${daemon.capabilities.serverVersion || daemon.capabilities.clientVersion || "?"}`;
    case "checking":
      return "Checking Docker…";
    case "not-installed":
      return "Docker not installed";
    case "daemon-down":
      return "Daemon down";
    case "permission-denied":
      return "Permission denied";
    case "offline":
      return "Docker unreachable";
    default:
      return "Docker";
  }
}

export function swarmLabel(caps: DockerCapabilities): string | null {
  if (!caps.swarmState || caps.swarmState === "inactive") return null;
  return `Swarm ${caps.swarmState}`;
}

export function composeLabel(caps: DockerCapabilities): string | null {
  if (caps.composeV2) return "Compose v2";
  if (caps.composeV1) return "Compose v1";
  return null;
}
