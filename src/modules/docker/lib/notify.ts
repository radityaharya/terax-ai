import type { DockerEvent } from "./dockerStore";

export type DockerNotification = {
  id: string;
  hostId: string;
  rule: "died" | "unhealthy" | "oom" | "update" | "underReplicated";
  title: string;
  body: string;
  /** Container or service to jump to on click. */
  target?: { kind: "container" | "service"; id: string; title: string };
};

function containerName(ev: DockerEvent): string {
  const attrs = ev.Actor?.Attributes ?? {};
  return attrs.name ?? ev.Actor?.ID?.slice(0, 12) ?? "container";
}

/**
 * Evaluate one docker event against the notification rules. Pure — the
 * caller checks mutes and fires the OS toast. Returns null when the event
 * matches no enabled rule.
 */
export function evaluateEvent(
  hostId: string,
  ev: DockerEvent,
  seenUpdates: Set<string>,
): DockerNotification | null {
  const action = String(ev.Action ?? "").toLowerCase();
  const type = String(ev.Type ?? "").toLowerCase();
  const attrs = ev.Actor?.Attributes ?? {};
  const name = containerName(ev);
  const id = String(ev.Actor?.ID ?? "");
  const key = `${type}:${action}:${id}:${ev.timeNano ?? ev.time ?? ""}`;

  // Container died (non-zero exit is more urgent, but any die notifies —
  // the user asked for died/unhealthy/OOM coverage).
  if (type === "container" && action === "die") {
    const exitCode = attrs.exitCode ?? "?";
    return {
      id: `died-${key}`,
      hostId,
      rule: "died",
      title: `Container died: ${name}`,
      body: `exit ${exitCode} on ${hostId}`,
      target: { kind: "container", id, title: name },
    };
  }
  // Health status flips to unhealthy.
  if (
    type === "container" &&
    (action === "health_status: unhealthy" || attrs.healthStatus === "unhealthy")
  ) {
    return {
      id: `unhealthy-${key}`,
      hostId,
      rule: "unhealthy",
      title: `Unhealthy: ${name}`,
      body: `health check failing on ${hostId}`,
      target: { kind: "container", id, title: name },
    };
  }
  // OOM kill.
  if (type === "container" && (action === "oom" || attrs.oomKilled === "true")) {
    return {
      id: `oom-${key}`,
      hostId,
      rule: "oom",
      title: `OOM killed: ${name}`,
      body: `out of memory on ${hostId}`,
      target: { kind: "container", id, title: name },
    };
  }
  void seenUpdates;
  return null;
}

/** Under-replicated swarm service (from service_ls replicaHealth). */
export function underReplicatedNotification(
  hostId: string,
  serviceId: string,
  serviceName: string,
  running: number,
  desired: number,
): DockerNotification {
  return {
    id: `underrep-${hostId}-${serviceId}-${running}-${desired}`,
    hostId,
    rule: "underReplicated",
    title: `Under-replicated: ${serviceName}`,
    body: `${running}/${desired} replicas on ${hostId}`,
    target: { kind: "service", id: serviceId, title: serviceName },
  };
}

/** Image update available (from the update-check flow). */
export function updateAvailableNotification(
  hostId: string,
  reference: string,
): DockerNotification {
  return {
    id: `update-${hostId}-${reference}`,
    hostId,
    rule: "update",
    title: `Update available: ${reference}`,
    body: `registry has a newer digest on ${hostId}`,
  };
}
