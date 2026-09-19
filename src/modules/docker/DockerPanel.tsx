import { cn } from "@/lib/utils";
import {
  RotateClockwiseIcon,
  Cancel01Icon,
  Delete02Icon,
  PlayIcon,
  StopIcon,
  Refresh01Icon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { daemonLabel } from "./lib/capabilities";
import {
  useDockerStore,
  type ContainerAction,
} from "./lib/dockerStore";
import type {
  DockerContainer,
  DockerResourceKind,
} from "./lib/types";

type Props = {
  /** Active tab's host id (null = local/WSL: v1 shows an empty state). */
  hostId: string | null;
  hostAlias?: string | null;
};

const SEGMENTS: { id: DockerResourceKind; label: string }[] = [
  { id: "containers", label: "Containers" },
  { id: "images", label: "Images" },
  { id: "volumes", label: "Volumes" },
  { id: "networks", label: "Networks" },
];

export function DockerPanel({ hostId, hostAlias }: Props) {
  const [segment, setSegment] = useState<DockerResourceKind>("containers");
  const [filter, setFilter] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const hostState = useDockerStore((s) =>
    hostId ? (s.byHost[hostId] ?? null) : null,
  );
  const refreshAll = useDockerStore((s) => s.refreshAll);
  const containerAction = useDockerStore((s) => s.containerAction);

  useEffect(() => {
    if (hostId) void refreshAll(hostId);
  }, [hostId, refreshAll]);

  const daemon = hostState?.daemon ?? { status: "unknown" as const };
  const containers = hostState?.containers;
  const busy = hostState?.busyContainers ?? {};

  const filteredContainers = useMemo(() => {
    if (!hostId) return [];
    const items = containers?.items ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) =>
      [containerId(c), containerName(c), c.Image, c.Status]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [hostId, containers?.items, filter]);

  const runAction = (action: ContainerAction, id: string) => {
    if (!hostId) return;
    if (action === "remove" && confirmRemove !== id) {
      setConfirmRemove(id);
      return;
    }
    setConfirmRemove(null);
    void containerAction(hostId, action, [id], { force: true });
  };

  if (!hostId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelTitle title="Docker" />
        <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
          Docker is host-scoped in v1. Open an SSH tab to browse its containers.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelTitle
        title="Docker"
        subtitle={hostAlias ?? hostId}
        right={
          <span className="flex items-center gap-1">
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {daemonLabel(daemon)}
            </span>
            <HeaderButton
              label="Refresh Docker"
              onClick={() => void refreshAll(hostId)}
            >
              <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
            </HeaderButton>
          </span>
        }
      />
      {daemon.status === "ready" ? (
        <>
          <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
            {SEGMENTS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSegment(s.id)}
                aria-pressed={segment === s.id}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
                  segment === s.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s.label}
                {s.id === "containers" && (containers?.items.length ?? 0) > 0 ? (
                  <span className="ml-1 text-[10px] text-muted-foreground/70">
                    {containers?.items.length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="shrink-0 px-2 pb-1.5">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${segment}`}
              className="h-7 w-full rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {segment === "containers" ? (
              containers?.loading && filteredContainers.length === 0 ? (
                <EmptyNote text="Loading containers…" />
              ) : containers?.error && filteredContainers.length === 0 ? (
                <EmptyNote text={containers.error} />
              ) : filteredContainers.length === 0 ? (
                <EmptyNote
                  text={filter ? "No containers match the filter." : "No containers on this host."}
                />
              ) : (
                filteredContainers.map((c) => {
                  const id = containerId(c);
                  const busyAction = busy[id];
                  return (
                    <ContainerRow
                      key={id}
                      container={c}
                      busy={busyAction}
                      confirmingRemove={confirmRemove === id}
                      onAction={(a) => runAction(a, id)}
                      onCancelRemove={() => setConfirmRemove(null)}
                    />
                  );
                })
              )
            ) : (
              <EmptyNote text={`${SEGMENTS.find((s) => s.id === segment)?.label} land with images/volumes wiring (D2).`} />
            )}
          </div>
        </>
      ) : daemon.status === "checking" || daemon.status === "unknown" ? (
        <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
          Checking Docker…
        </div>
      ) : (
        <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
          {daemonLabel(daemon)}
          {"message" in daemon && daemon.message ? (
            <div className="mt-1 break-words text-[10px]">{daemon.message}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function containerId(c: DockerContainer): string {
  const raw = (c.ID ?? c.Id ?? "") as string;
  return raw.replace(/^sha256:/, "").slice(0, 12) || String(c.Names ?? c.Name ?? "?");
}

export function containerName(c: DockerContainer): string {
  const raw = String(c.Names ?? c.Name ?? "");
  return raw.split(",")[0]?.replace(/^\//, "").trim() || containerId(c);
}

function containerState(c: DockerContainer): "running" | "exited" | "paused" | "dead" | "unknown" {
  const s = String(c.State ?? "").toLowerCase();
  if (s.includes("running")) return "running";
  if (s.includes("paused")) return "paused";
  if (s.includes("dead") || s.includes("removing")) return "dead";
  if (s.includes("exited") || s.includes("created")) return "exited";
  // `docker ps --format json` emits State + Status ("Up 2 hours").
  const status = String(c.Status ?? "").toLowerCase();
  if (status.startsWith("up")) return "running";
  if (status.startsWith("exited") || status.startsWith("created")) return "exited";
  if (status.includes("paused")) return "paused";
  return "unknown";
}

const STATE_DOT: Record<string, string> = {
  running: "bg-emerald-500",
  exited: "bg-muted-foreground/40",
  paused: "bg-amber-400",
  dead: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

function ContainerRow({
  container,
  busy,
  confirmingRemove,
  onAction,
  onCancelRemove,
}: {
  container: DockerContainer;
  busy: ContainerAction | undefined;
  confirmingRemove: boolean;
  onAction: (a: ContainerAction) => void;
  onCancelRemove: () => void;
}) {
  const id = containerId(container);
  const name = containerName(container);
  const state = containerState(container);
  const running = state === "running";
  const detail = String(container.Status ?? container.Image ?? "");
  return (
    // biome-ignore lint/a11y/useSemanticElements: row hosts nested buttons, cannot be a <button>
    <div
      role="button"
      tabIndex={0}
      title={`${name} (${id})`}
      className="group relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <span
        role="img"
        aria-label={state}
        title={state}
        className={cn("size-2 shrink-0 rounded-full", STATE_DOT[state])}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] font-medium leading-tight">
          {name}
          {busy ? (
            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/70">
              {busy === "remove" ? "removing…" : `${busy}ing…`}
            </span>
          ) : null}
        </span>
        <span className="truncate text-[10px] leading-tight text-muted-foreground/60">
          {confirmingRemove ? `Remove ${name}?` : detail}
        </span>
      </span>
      {confirmingRemove ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAction("remove");
            }}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
          >
            Remove
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancelRemove();
            }}
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
          >
            Keep
          </button>
        </span>
      ) : (
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {running ? (
            <>
              <RowButton label={`Stop ${name}`} onClick={() => onAction("stop")}>
                <HugeiconsIcon icon={StopIcon} size={13} strokeWidth={1.75} />
              </RowButton>
              <RowButton label={`Restart ${name}`} onClick={() => onAction("restart")}>
                <HugeiconsIcon icon={RotateClockwiseIcon} size={13} strokeWidth={1.75} />
              </RowButton>
              <RowButton label={`Kill ${name}`} onClick={() => onAction("kill")}>
                <HugeiconsIcon icon={ZapIcon} size={13} strokeWidth={1.75} />
              </RowButton>
            </>
          ) : (
            <RowButton label={`Start ${name}`} onClick={() => onAction("start")}>
              <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.75} />
            </RowButton>
          )}
          <RowButton label={`Remove ${name}`} onClick={() => onAction("remove")}>
            <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
          </RowButton>
          <RowButton label="Cancel" onClick={onCancelRemove}>
            <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
          </RowButton>
        </span>
      )}
    </div>
  );
}

function PanelTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string | null;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between px-2.5 pb-1.5 pt-2">
      <span className="flex min-w-0 items-baseline gap-1.5 text-xs font-semibold text-foreground">
        {title}
        {subtitle ? (
          <span className="truncate text-[10px] font-normal text-muted-foreground/70">
            {subtitle}
          </span>
        ) : null}
      </span>
      {right}
    </div>
  );
}

function HeaderButton({
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
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function RowButton({
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

function EmptyNote({ text }: { text: string }) {
  return (
    <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
      {text}
    </div>
  );
}
