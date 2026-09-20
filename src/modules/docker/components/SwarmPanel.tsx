import { cn } from "@/lib/utils";
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
import {
  useDockerStore,
  type SwarmNode,
  type SwarmService,
} from "../lib/dockerStore";

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
  const stackAction = useDockerStore((s) => s.stackAction);
  const nodeAction = useDockerStore((s) => s.nodeAction);
  const refreshStackDrift = useDockerStore((s) => s.refreshStackDrift);
  const [scaleTarget, setScaleTarget] = useState<{ id: string; name: string; replicas: string } | null>(null);
  const [confirmStackRm, setConfirmStackRm] = useState<string | null>(null);
  const [driftStack, setDriftStack] = useState<string | null>(null);

  useEffect(() => {
    if (swarmActive) void refreshSwarm(hostId);
  }, [hostId, swarmActive, refreshSwarm]);

  if (!swarmActive) return null;

  const busy = swarm?.busyService ?? {};
  const drift = swarm?.drift ?? {};

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
            onRollback={() => void serviceAction(hostId, "rollback", serviceId(svc))}
            onRemove={() => void serviceAction(hostId, "rm", serviceId(svc))}
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
              void serviceAction(hostId, "scale", scaleTarget.id, { replicas: n });
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
          onAction={(a) => void nodeAction(hostId, a, nodeId(n))}
        />
      ))}
      <SectionTitle title="Stacks" count={swarm?.stacks.length ?? 0} />
      {(swarm?.stacks ?? []).length === 0 ? (
        <div className="px-2 py-2 text-center text-[11px] text-muted-foreground/70">
          No stacks deployed.
        </div>
      ) : (
        (swarm?.stacks ?? []).map((st) => {
          const name = String(st.Name ?? "?");
          const d = drift[name];
          const drifted = d && JSON.stringify(d.running) !== JSON.stringify(d.desired);
          return (
            <div key={name} className="rounded-md border border-border/40 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                  {name}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                  {String(st.Services ?? "")} svc
                </span>
                {drifted ? (
                  <span className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400" title={`Running differs from compose file.\nRunning: ${(d?.running ?? []).join(", ")}\nDesired: ${(d?.desired ?? []).join(", ")}`}>
                    drifted
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex items-center gap-0.5">
                {confirmStackRm === name ? (
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmStackRm(null);
                        void stackAction(hostId, "rm", name);
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
                    >
                      Confirm remove
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmStackRm(null)}
                      className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <>
                    <SmallButton label={`Check drift for ${name}`} onClick={() => {
                      setDriftStack(name);
                      // Compose file path resolved from the stack's services in a later pass;
                      // for now drift checks the services list itself.
                      void refreshStackDrift(hostId, name, "");
                    }}>
                      <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} />
                    </SmallButton>
                    <SmallButton label={`Remove stack ${name}`} onClick={() => setConfirmStackRm(name)}>
                      <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
                    </SmallButton>
                  </>
                )}
                {driftStack === name && d ? (
                  <span className="ml-1 truncate text-[10px] text-muted-foreground/70">
                    run: {d.running.join(", ") || "—"} · want: {d.desired.join(", ") || "—"}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })
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
  const [confirmRm, setConfirmRm] = useState(false);
  return (
    <div className="group rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50">
      <div className="flex items-center gap-1.5">
        <span
          role="img"
          aria-label={under ? "under-replicated" : "healthy"}
          className={cn(
            "size-2 shrink-0 rounded-full",
            under ? "bg-amber-400" : "bg-emerald-500",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
          {name}
          {busy ? (
            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/70">
              {busy}…
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {health ? `${health.running}/${health.desired}` : String(service.Replicas ?? "")}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground/60">
        {String(service.Image ?? "")}
      </div>
      {confirmRm ? (
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            onClick={onRemove}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
          >
            Confirm remove
          </button>
          <button
            type="button"
            onClick={() => setConfirmRm(false)}
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
          >
            Keep
          </button>
        </div>
      ) : (
        <div className="mt-1 hidden items-center gap-0.5 group-hover:flex">
          <SmallButton label={`Scale ${name}`} onClick={onScale}>
            <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={1.75} />
          </SmallButton>
          <SmallButton label={`Logs for ${name}`} onClick={onLogs}>
            <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={1.75} />
          </SmallButton>
          <SmallButton label={`Rollback ${name}`} onClick={onRollback}>
            <HugeiconsIcon icon={RotateClockwiseIcon} size={12} strokeWidth={1.75} />
          </SmallButton>
          <SmallButton label={`Remove ${name}`} onClick={() => setConfirmRm(true)}>
            <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
          </SmallButton>
        </div>
      )}
    </div>
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
    <div className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50">
      <span
        role="img"
        aria-label={status}
        className={cn(
          "size-2 shrink-0 rounded-full",
          status === "Ready" ? "bg-emerald-500" : status === "Down" ? "bg-destructive" : "bg-amber-400",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] font-medium leading-tight">
          {hostname}
          {manager ? <span className="ml-1.5 text-[10px] text-muted-foreground/70">{manager}</span> : null}
        </span>
        <span className="truncate text-[10px] leading-tight text-muted-foreground/60">
          {availability} · {String(node.EngineVersion ?? "")}
        </span>
      </span>
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        {availability === "Drain" ? (
          <SmallButton label={`Activate ${hostname}`} onClick={() => onAction("activate")}>
            <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={1.75} />
          </SmallButton>
        ) : (
          <SmallButton label={`Drain ${hostname}`} onClick={() => onAction("drain")}>
            <HugeiconsIcon icon={StopIcon} size={12} strokeWidth={1.75} />
          </SmallButton>
        )}
      </span>
    </div>
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

function SmallButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}


