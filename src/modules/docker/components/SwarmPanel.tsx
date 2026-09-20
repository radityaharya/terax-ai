import {
  ArrowDown01Icon,
  Cancel01Icon,
  Delete02Icon,
  PlayIcon,
  Refresh01Icon,
  RotateClockwiseIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { confirmDockerAction } from "../lib/dockerConfirmStore";
import {
  useDockerStore,
  type SwarmNode,
  type SwarmService,
} from "../lib/dockerStore";
import { ResourceRow } from "./ResourceRow";
import { StackCard } from "./StackCard";

type Props = {
  hostId: string;
  swarmActive: boolean;
  onOpenServiceLogs: (serviceId: string, title: string) => void;
};

/** Swarm section: nodes, services (replica mismatch), stacks. */
export function SwarmPanel({ hostId, swarmActive, onOpenServiceLogs }: Props) {
  const swarm = useDockerStore((s) => s.byHost[hostId]?.swarm);
  const refreshSwarm = useDockerStore((s) => s.refreshSwarm);
  const serviceAction = useDockerStore((s) => s.serviceAction);
  const nodeAction = useDockerStore((s) => s.nodeAction);
  const [scaleTarget, setScaleTarget] = useState<{ id: string; name: string; replicas: string } | null>(null);

  useEffect(() => {
    if (swarmActive) void refreshSwarm(hostId);
  }, [hostId, swarmActive, refreshSwarm]);

  if (!swarmActive) return null;

  const busy = swarm?.busyService ?? {};
  const drift = swarm?.drift ?? {};

  const handleRollback = async (svc: SwarmService) => {
    const name = serviceName(svc);
    const confirmed = await confirmDockerAction({
      title: "Rollback swarm service",
      actionLabel: "Rollback",
      actionVariant: "warning",
      resourceKind: "Swarm Service",
      resourceName: name,
      resourceDetails: `Image: ${String(svc.Image ?? "")}`,
      hostAlias: hostId,
      description: "Rolls back the service configuration to its previous version across all replicas in the swarm.",
    });
    if (!confirmed) return;
    void serviceAction(hostId, "rollback", serviceId(svc));
  };

  const handleRemoveService = async (svc: SwarmService) => {
    const name = serviceName(svc);
    const confirmed = await confirmDockerAction({
      title: "Remove swarm service",
      actionLabel: "Remove",
      actionVariant: "destructive",
      resourceKind: "Swarm Service",
      resourceName: name,
      resourceDetails: `ID: ${serviceId(svc)} · Image: ${String(svc.Image ?? "")}`,
      hostAlias: hostId,
      description: "Permanently removes this service and terminates all its replica tasks across the swarm.",
    });
    if (!confirmed) return;
    void serviceAction(hostId, "rm", serviceId(svc));
  };

  const handleNodeAction = async (a: "drain" | "activate" | "pause" | "promote" | "demote", node: SwarmNode) => {
    const id = nodeId(node);
    const hostname = String(node.Hostname ?? id);
    const isDrain = a === "drain";
    const confirmed = await confirmDockerAction({
      title: isDrain ? "Drain swarm node" : `Set node to ${a}`,
      actionLabel: isDrain ? "Drain node" : a,
      actionVariant: isDrain ? "warning" : "default",
      resourceKind: "Swarm Node",
      resourceName: hostname,
      resourceDetails: `Node ID: ${id} · Status: ${String(node.Status ?? "")}`,
      hostAlias: hostId,
      description: isDrain
        ? "Tasks on this node will be stopped and rescheduled on other active swarm nodes."
        : `Sets node availability to ${a}. Node will resume accepting tasks.`,
    });
    if (!confirmed) return;
    void nodeAction(hostId, a, id);
  };



  return (
    <div className="flex flex-col gap-2 px-1.5 pb-2">
      {swarm?.error ? (
        <div className="break-words rounded-md border border-destructive/30 px-2 py-1.5 text-[11px] text-destructive">
          {swarm.error}
        </div>
      ) : null}
      <SectionTitle
        title="Services"
        count={swarm?.services.length ?? 0}
        onRefresh={() => void refreshSwarm(hostId)}
        loading={swarm?.loading ?? false}
      />
      {(swarm?.services ?? []).length === 0 ? (
        <div className="px-2 py-2 text-center text-[11px] text-muted-foreground/70">
          {swarm?.loading ? "Loading services…" : "No swarm services."}
        </div>
      ) : (
        (swarm?.services ?? []).map((svc) => (
          <ServiceRow
            key={serviceId(svc)}
            service={svc}
            busy={busy[serviceId(svc)]}
            onScale={() =>
              setScaleTarget({
                id: serviceId(svc),
                name: serviceName(svc),
                replicas: String(svc.replicaHealth?.desired ?? 1),
              })
            }
            onLogs={() => onOpenServiceLogs(serviceId(svc), serviceName(svc))}
            onRollback={() => void handleRollback(svc)}
            onRemove={() => void handleRemoveService(svc)}
          />
        ))
      )}
      {scaleTarget ? (
        <ScalePrompt
          name={scaleTarget.name}
          replicas={scaleTarget.replicas}
          onChange={(v) => setScaleTarget({ ...scaleTarget, replicas: v })}
          onSubmit={() => {
            const n = Number(scaleTarget.replicas);
            if (Number.isInteger(n) && n >= 0 && n <= 1024) {
              void (async () => {
                const confirmed = await confirmDockerAction({
                  title: "Scale swarm service",
                  actionLabel: "Scale",
                  actionVariant: "default",
                  resourceKind: "Swarm Service",
                  resourceName: scaleTarget.name,
                  resourceDetails: `Target replicas: ${n}`,
                  hostAlias: hostId,
                  description: `Updates desired replica count to ${n}. Swarm will schedule or terminate tasks accordingly.`,
                });
                if (!confirmed) return;
                void serviceAction(hostId, "scale", scaleTarget.id, { replicas: n });
              })();
            }
            setScaleTarget(null);
          }}
          onClose={() => setScaleTarget(null)}
        />
      ) : null}
      <SectionTitle title="Nodes" count={swarm?.nodes.length ?? 0} />
      {(swarm?.nodes ?? []).map((n) => (
        <NodeRow
          key={nodeId(n)}
          node={n}
          onAction={(a) => void handleNodeAction(a, n)}
        />
      ))}
      <SectionTitle title="Stacks" count={swarm?.stacks.length ?? 0} />
      {(swarm?.stacks ?? []).length === 0 ? (
        <div className="px-2 py-2 text-center text-[11px] text-muted-foreground/70">
          No stacks deployed.
        </div>
      ) : (
        (swarm?.stacks ?? []).map((st) => (
          <StackCard
            key={String(st.Name ?? "?")}
            hostId={hostId}
            stack={st}
            onOpenServiceLogs={onOpenServiceLogs}
            drift={drift[String(st.Name ?? "?")] ?? null}
          />
        ))
      )}
    </div>
  );
}

function serviceId(s: SwarmService): string {
  return String(s.ID ?? s.Name ?? "?").replace(/^sha256:/, "").slice(0, 25);
}

function serviceName(s: SwarmService): string {
  return String(s.Name ?? s.ID ?? "?");
}

function nodeId(n: SwarmNode): string {
  return String(n.ID ?? n.Hostname ?? "?");
}

function SectionTitle({
  title,
  count,
  onRefresh,
  loading,
}: {
  title: string;
  count: number;
  onRefresh?: () => void;
  loading?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 px-1 pt-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        {title}
      </span>
      <span className="text-[10px] tabular-nums text-muted-foreground/50">{count}</span>
      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          title={`Refresh ${title.toLowerCase()}`}
          className="flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon
            icon={Refresh01Icon}
            size={12}
            strokeWidth={1.75}
            className={loading ? "animate-spin" : undefined}
          />
        </button>
      ) : null}
    </div>
  );
}

function ServiceRow({
  service,
  busy,
  onScale,
  onLogs,
  onRollback,
  onRemove,
}: {
  service: SwarmService;
  busy: string | undefined;
  onScale: () => void;
  onLogs: () => void;
  onRollback: () => void;
  onRemove: () => void;
}) {
  const name = serviceName(service);
  const health = service.replicaHealth;
  const under = health?.underReplicated ?? false;
  return (
    <ResourceRow
      tone={under ? "warn" : "ok"}
      toneLabel={under ? "under-replicated" : "healthy"}
      title={
        <>
          <span className="min-w-0 truncate">{name}</span>
          {busy ? (
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground/70">
              {busy}…
            </span>
          ) : null}
          <span className="ml-auto shrink-0 pl-2 text-[10px] font-normal tabular-nums text-muted-foreground/70">
            {health
              ? `${health.running}/${health.desired}`
              : String(service.Replicas ?? "")}
          </span>
        </>
      }
      subtitle={String(service.Image ?? "")}
      actions={[
        {
          key: "scale",
          label: `Scale ${name}`,
          icon: (
            <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={1.75} />
          ),
          onClick: onScale,
        },
        {
          key: "logs",
          label: `Logs for ${name}`,
          icon: <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={1.75} />,
          onClick: onLogs,
        },
        {
          key: "rollback",
          label: `Rollback ${name}`,
          icon: (
            <HugeiconsIcon
              icon={RotateClockwiseIcon}
              size={12}
              strokeWidth={1.75}
            />
          ),
          onClick: onRollback,
        },
        {
          key: "remove",
          label: `Remove ${name}`,
          icon: <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />,
          onClick: onRemove,
          danger: true,
        },
      ]}
    />
  );
}

function NodeRow({
  node,
  onAction,
}: {
  node: SwarmNode;
  onAction: (a: "drain" | "activate" | "pause" | "promote" | "demote") => void;
}) {
  const id = nodeId(node);
  const hostname = String(node.Hostname ?? id);
  const availability = String(node.Availability ?? "");
  const status = String(node.Status ?? "");
  const manager = String(node.ManagerStatus ?? "");
  return (
    <ResourceRow
      tone={
        status === "Ready" ? "ok" : status === "Down" ? "hot" : "warn"
      }
      toneLabel={status}
      title={
        <>
          <span className="min-w-0 truncate">{hostname}</span>
          {manager ? (
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground/70">
              {manager}
            </span>
          ) : null}
        </>
      }
      subtitle={`${availability} · ${String(node.EngineVersion ?? "")}`}
      actions={[
        availability === "Drain"
          ? {
              key: "activate",
              label: `Activate ${hostname}`,
              icon: (
                <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={1.75} />
              ),
              onClick: () => onAction("activate"),
            }
          : {
              key: "drain",
              label: `Drain ${hostname}`,
              icon: (
                <HugeiconsIcon icon={StopIcon} size={12} strokeWidth={1.75} />
              ),
              onClick: () => onAction("drain"),
            },
      ]}
    />
  );
}

function ScalePrompt({
  name,
  replicas,
  onChange,
  onSubmit,
  onClose,
}: {
  name: string;
  replicas: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-md border border-border/40 px-2 py-1.5">
      <div className="text-[11px] font-medium">Scale {name}</div>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          value={replicas}
          onChange={(e) => onChange(e.target.value)}
          inputMode="numeric"
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
            if (e.key === "Escape") onClose();
          }}
          className="h-6 w-16 rounded border border-border/60 bg-background px-1.5 text-[11px] tabular-nums outline-none focus:border-primary/50"
        />
        <span className="text-[10px] text-muted-foreground/70">replicas (0–1024)</span>
        <button
          type="button"
          onClick={onSubmit}
          className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:opacity-90"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cancel scale"
          className="flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}


