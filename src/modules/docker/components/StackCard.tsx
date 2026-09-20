import { cn } from "@/lib/utils";
import {
  Delete02Icon,
  PlayIcon,
  RotateClockwiseIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { confirmDockerAction } from "../lib/dockerConfirmStore";
import {
  useDockerStore,
  type SwarmService,
  type SwarmStack,
  type SwarmStackTask,
} from "../lib/dockerStore";
import { ResourceRow } from "./ResourceRow";

type Props = {
  hostId: string;
  stack: SwarmStack;
  onOpenServiceLogs: (serviceId: string, title: string) => void;
  drift?: { running: string[]; desired: string[] } | null;
};

/**
 * First-class stack card: health rollup in the header, an expandable task
 * body grouped per service (replica count, task states, node + error), and
 * the stack-level controls — force update, rollback, drift check, remove.
 */
export function StackCard({ hostId, stack, onOpenServiceLogs, drift }: Props) {
  const name = String(stack.Name ?? "?");
  const servicesCount = String(stack.Services ?? "");
  const services = useDockerStore((s) => s.byHost[hostId]?.swarm.services ?? []);
  const tasks = useDockerStore(
    (s) => s.byHost[hostId]?.swarm.stackTasks[name] ?? null,
  );
  const busy = useDockerStore((s) => s.byHost[hostId]?.swarm.busyService ?? {});
  const refreshStackTasks = useDockerStore((s) => s.refreshStackTasks);
  const serviceAction = useDockerStore((s) => s.serviceAction);
  const stackAction = useDockerStore((s) => s.stackAction);
  const [expanded, setExpanded] = useState(false);

  // Tasks only exist on demand: fetch on expand. Refresh when the card
  // re-expands so restart/update/rollback results surface without a manual
  // reload of the whole swarm section.
  useEffect(() => {
    if (expanded) void refreshStackTasks(hostId, name);
  }, [expanded, hostId, name, refreshStackTasks]);

  const drifted =
    drift && JSON.stringify(drift.running) !== JSON.stringify(drift.desired);

  // Services under this stack, matched by the `stack_service` prefix the
  // daemon applies to stack service names.
  const stackServices = services.filter(
    (s) => serviceName(s) === name || serviceName(s).startsWith(`${name}_`),
  );

  const liveTasks = (tasks ?? []).filter(taskIsLive);
  const healthy = liveTasks.filter((t) => t.taskHealthy).length;
  const taskTotal = liveTasks.length;
  const allHealthy = taskTotal === 0 || healthy === taskTotal;

  const handleForceUpdateService = async (svc: SwarmService) => {
    const svcName = serviceName(svc);
    const confirmed = await confirmDockerAction({
      title: "Force update swarm service",
      actionLabel: "Force update",
      actionVariant: "warning",
      resourceKind: "Swarm Service",
      resourceName: svcName,
      resourceDetails: `ID: ${serviceId(svc)} · Image: ${String(svc.Image ?? "")}`,
      hostAlias: hostId,
      description:
        "Re-pulls the image and restarts every replica of this service, even if the spec is unchanged (rolling restart).",
    });
    if (!confirmed) return;
    void serviceAction(hostId, "force-update", serviceId(svc));
  };

  const handleRollbackService = async (svc: SwarmService) => {
    const svcName = serviceName(svc);
    const confirmed = await confirmDockerAction({
      title: "Rollback swarm service",
      actionLabel: "Rollback",
      actionVariant: "warning",
      resourceKind: "Swarm Service",
      resourceName: svcName,
      resourceDetails: `Image: ${String(svc.Image ?? "")}`,
      hostAlias: hostId,
      description:
        "Rolls back the service configuration to its previous version across all replicas in the swarm.",
    });
    if (!confirmed) return;
    void serviceAction(hostId, "rollback", serviceId(svc));
  };

  const handleForceUpdateStack = async () => {
    const confirmed = await confirmDockerAction({
      title: "Force update stack",
      actionLabel: "Force update",
      actionVariant: "warning",
      resourceKind: "Swarm Stack",
      resourceName: name,
      resourceDetails:
        servicesCount !== "" ? `${servicesCount} service(s)` : undefined,
      hostAlias: hostId,
      description:
        "Re-pulls images and restarts every replica of every service in this stack (rolling restart per service).",
    });
    if (!confirmed) return;
    for (const svc of stackServices) {
      await serviceAction(hostId, "force-update", serviceId(svc));
    }
    if (expanded) void refreshStackTasks(hostId, name);
  };

  const handleRollbackStack = async () => {
    const confirmed = await confirmDockerAction({
      title: "Rollback stack",
      actionLabel: "Rollback",
      actionVariant: "warning",
      resourceKind: "Swarm Stack",
      resourceName: name,
      resourceDetails:
        servicesCount !== "" ? `${servicesCount} service(s)` : undefined,
      hostAlias: hostId,
      description:
        "Rolls back every service in this stack to its previous configuration.",
    });
    if (!confirmed) return;
    for (const svc of stackServices) {
      await serviceAction(hostId, "rollback", serviceId(svc));
    }
    if (expanded) void refreshStackTasks(hostId, name);
  };

  const handleRemove = async () => {
    const confirmed = await confirmDockerAction({
      title: "Remove swarm stack",
      actionLabel: "Remove",
      actionVariant: "destructive",
      resourceKind: "Swarm Stack",
      resourceName: name,
      resourceDetails:
        servicesCount !== "" ? `${servicesCount} service(s)` : undefined,
      hostAlias: hostId,
      description:
        "Removes this stack and terminates all services and tasks deployed under it.",
    });
    if (!confirmed) return;
    void stackAction(hostId, "rm", name);
  };

  return (
    <div className="rounded-md border border-border/40 px-2 py-1.5">
      <ResourceRow
        tone={allHealthy ? "ok" : "hot"}
        toneLabel={allHealthy ? "healthy" : "degraded"}
        title={
          <>
            <span className="min-w-0 truncate">{name}</span>
            <span className="ml-auto shrink-0 pl-2 text-[10px] font-normal tabular-nums text-muted-foreground/70">
              {tasks === null
                ? `${servicesCount} svc`
                : `${healthy}/${taskTotal} tasks`}
            </span>
          </>
        }
        subtitle={
          drifted ? (
            <span className="font-medium text-amber-600 dark:text-amber-400">
              drifted from compose file
            </span>
          ) : (
            `${servicesCount} service(s)`
          )
        }
        actions={[
          {
            key: "expand",
            label: expanded ? `Collapse tasks for ${name}` : `Show tasks for ${name}`,
            icon: (
              <span aria-hidden className="text-sm leading-none">
                {expanded ? "▾" : "▸"}
              </span>
            ),
            onClick: () => setExpanded((v) => !v),
          },
          {
            key: "force-update",
            label: `Force update stack ${name}`,
            icon: <HugeiconsIcon icon={ZapIcon} size={12} strokeWidth={1.75} />,
            onClick: () => void handleForceUpdateStack(),
          },
          {
            key: "rollback",
            label: `Rollback stack ${name}`,
            icon: (
              <HugeiconsIcon
                icon={RotateClockwiseIcon}
                size={12}
                strokeWidth={1.75}
              />
            ),
            onClick: () => void handleRollbackStack(),
          },
          {
            key: "remove",
            label: `Remove stack ${name}`,
            icon: (
              <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
            ),
            onClick: () => void handleRemove(),
            danger: true,
          },
        ]}
      />
      {expanded ? (
        <div className="mt-1 flex flex-col gap-1 border-t border-border/40 pt-1">
          {tasks === null ? (
            <div className="px-1 py-1 text-[10px] text-muted-foreground/70">
              Loading tasks…
            </div>
          ) : taskTotal === 0 ? (
            <div className="px-1 py-1 text-[10px] text-muted-foreground/70">
              No tasks for this stack.
            </div>
          ) : (
            <StackServiceGroups
              tasks={tasks}
              onServiceLogs={onOpenServiceLogs}
              onForceUpdate={(svc) =>
                void handleForceUpdateService(
                  services.find((s) => serviceName(s) === svc) ?? {
                    Name: svc,
                  },
                )
              }
              onRollback={(svc) =>
                void handleRollbackService(
                  services.find((s) => serviceName(s) === svc) ?? {
                    Name: svc,
                  },
                )
              }
              busy={busy}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function serviceName(s: { Name?: unknown; ID?: unknown }): string {
  return String(s.Name ?? s.ID ?? "?");
}

function serviceId(s: { ID?: unknown; Name?: unknown }): string {
  return String(s.ID ?? s.Name ?? "?").replace(/^sha256:/, "").slice(0, 25);
}

/** Tasks grouped by service with per-service health + actions. */
function StackServiceGroups({
  tasks,
  onServiceLogs,
  onForceUpdate,
  onRollback,
  busy,
}: {
  tasks: SwarmStackTask[];
  onServiceLogs: (serviceId: string, title: string) => void;
  onForceUpdate: (service: string) => void;
  onRollback: (service: string) => void;
  busy: Record<string, string>;
}) {
  const groups = groupTasksByService(tasks.filter(taskIsLive));
  const retiredByService = new Map<string, number>();
  for (const t of tasks) {
    if (taskIsLive(t)) continue;
    const svc = taskServiceName(t);
    retiredByService.set(svc, (retiredByService.get(svc) ?? 0) + 1);
  }
  return (
    <div className="flex flex-col gap-1">
      {groups.map((g) => {
        const healthy = g.tasks.filter((t) => t.taskHealthy).length;
        const allOk = healthy === g.tasks.length;
        const retired = retiredByService.get(g.service) ?? 0;
        return (
          <div
            key={g.service}
            className="rounded bg-accent/40 px-1.5 py-1"
            title={`${healthy}/${g.tasks.length} healthy`}
          >
            <div className="flex items-center gap-1.5">
              <span
                role="img"
                aria-label={allOk ? "healthy" : "degraded"}
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  allOk ? "bg-emerald-500" : "bg-destructive",
                )}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-medium text-foreground">
                {g.service}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                {healthy}/{g.tasks.length}
              </span>
              {retired > 0 ? (
                <span
                  className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40"
                  title={`${retired} superseded task(s) hidden: old replicas kept by the daemon for history`}
                >
                  +{retired} old
                </span>
              ) : null}
              {busy[g.serviceId] ? (
                <span className="shrink-0 text-[10px] text-muted-foreground/70">
                  {busy[g.serviceId]}…
                </span>
              ) : null}
              <span className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  aria-label={`Force update ${g.service}`}
                  title={`Force update ${g.service}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onForceUpdate(g.service);
                  }}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                >
                  <HugeiconsIcon icon={ZapIcon} size={11} strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label={`Rollback ${g.service}`}
                  title={`Rollback ${g.service}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRollback(g.service);
                  }}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                >
                  <HugeiconsIcon
                    icon={RotateClockwiseIcon}
                    size={11}
                    strokeWidth={1.75}
                  />
                </button>
                <button
                  type="button"
                  aria-label={`Logs for ${g.service}`}
                  title={`Logs for ${g.service}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onServiceLogs(g.serviceId, g.service);
                  }}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                >
                  <HugeiconsIcon icon={PlayIcon} size={11} strokeWidth={1.75} />
                </button>
              </span>
            </div>
            {g.tasks.map((t) => (
              <div
                key={String(t.ID ?? t.Name ?? Math.random())}
                className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10px] text-muted-foreground/70"
                title={taskTitle(t)}
              >
                <span
                  className={cn(
                    "size-1 shrink-0 rounded-full",
                    t.taskHealthy ? "bg-emerald-500" : "bg-destructive",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">
                  {String(t.CurrentState ?? "—")}
                  {t.Error ? ` · ${t.Error}` : ""}
                </span>
                {t.Node ? (
                  <span className="shrink-0 truncate">{t.Node}</span>
                ) : null}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function taskTitle(t: SwarmStackTask): string {
  const parts = [t.Name, t.Image, t.Error, t.Node]
    .map((v) => (v == null ? "" : String(v)))
    .filter(Boolean);
  return `${t.CurrentState ?? "—"} · ${parts.join(" · ")}`;
}

export type TaskGroup = {
  service: string;
  serviceId: string;
  tasks: SwarmStackTask[];
};

/**
 * Groups `stack ps` rows by their service. Task names look like
 * `<stack>_<svc>.<slot>.<taskid>` — the slot and task id are the last two
 * dot-separated segments, so the service part is everything before them.
 */
export function groupTasksByService(
  tasks: SwarmStackTask[],
): TaskGroup[] {
  const byService = new Map<string, TaskGroup>();
  for (const t of tasks) {
    const service = taskServiceName(t);
    let group = byService.get(service);
    if (!group) {
      group = { service, serviceId: service, tasks: [] };
      byService.set(service, group);
    }
    group.tasks.push(t);
  }
  return [...byService.values()];
}

/** `<stack>_<svc>.<slot>.<taskid>` -> `<stack>_<svc>`. Anything that does
 *  not match the shape is returned as-is (or "?" when unnamed). */
export function taskServiceName(t: SwarmStackTask): string {
  const raw = String(t.Name ?? "").trim();
  if (!raw) return "?";
  const parts = raw.split(".");
  if (parts.length >= 3) return parts.slice(0, -2).join(".");
  return raw;
}

/**
 * Is this task one the scheduler currently wants running? `stack ps` is
 * task *history*: superseded replicas linger as `DesiredState: Shutdown`.
 * Counting those makes every long-lived service look degraded (1/4 while
 * the single desired replica is happily Running), so health rolls up over
 * live tasks only. Missing `DesiredState` (very old daemons) counts as
 * live to preserve the previous behavior.
 */
export function taskIsLive(t: SwarmStackTask): boolean {
  const d = t.DesiredState;
  if (d == null || String(d).trim() === "") return true;
  return String(d).trim().toLowerCase() === "running";
}


