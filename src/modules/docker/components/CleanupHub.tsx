import { cn } from "@/lib/utils";
import { Cancel01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  useDockerStore,
  type DiskUsage,
  type PruneTarget,
} from "../lib/dockerStore";

type Props = {
  hostId: string;
  onClose: () => void;
};

const ROWS: {
  target: PruneTarget;
  label: string;
  size: (d: DiskUsage) => string;
  reclaimable: (d: DiskUsage) => string;
  options?: { all?: boolean; volumes?: boolean };
  optionLabel?: string;
}[] = [
  {
    target: "containers",
    label: "Stopped containers",
    size: (d) => d.containersSize,
    reclaimable: (d) => d.containersReclaimable,
  },
  {
    target: "images",
    label: "Unused images",
    size: (d) => d.imagesSize,
    reclaimable: (d) => d.imagesReclaimable,
    options: { all: true },
    optionLabel: "Remove all unused (not just dangling)",
  },
  {
    target: "volumes",
    label: "Unused volumes",
    size: (d) => d.volumesSize,
    reclaimable: (d) => d.volumesReclaimable,
  },
  {
    target: "networks",
    label: "Unused networks",
    size: () => "—",
    reclaimable: () => "—",
  },
  {
    target: "builder",
    label: "Build cache",
    size: (d) => d.buildCacheSize,
    reclaimable: (d) => d.buildCacheReclaimable,
  },
  {
    target: "system",
    label: "Everything unused",
    size: () => "—",
    reclaimable: () => "—",
    options: { all: true, volumes: true },
    optionLabel: "Include unused images + volumes",
  },
];

/** `docker system df` + per-category prune with explicit confirm. */
export function CleanupHub({ hostId, onClose }: Props) {
  const disk = useDockerStore((s) => s.byHost[hostId]?.disk ?? null);
  const diskLoading = useDockerStore((s) => s.byHost[hostId]?.diskLoading ?? false);
  const diskError = useDockerStore((s) => s.byHost[hostId]?.diskError ?? null);
  const pruning = useDockerStore((s) => s.byHost[hostId]?.pruning ?? null);
  const pruneOutput = useDockerStore((s) => s.byHost[hostId]?.pruneOutput ?? null);
  const refreshDisk = useDockerStore((s) => s.refreshDisk);
  const prune = useDockerStore((s) => s.prune);
  const clearPruneOutput = useDockerStore((s) => s.clearPruneOutput);
  const [confirming, setConfirming] = useState<PruneTarget | null>(null);

  useEffect(() => {
    void refreshDisk(hostId);
  }, [hostId, refreshDisk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const runPrune = (target: PruneTarget, opts?: { all?: boolean; volumes?: boolean }) => {
    if (confirming !== target) {
      setConfirming(target);
      return;
    }
    setConfirming(null);
    void prune(hostId, target, opts);
  };

  return (
    <div
      className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l border-border/60 bg-background shadow-xl"
      role="dialog"
      aria-label="Docker disk usage and cleanup"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          Disk usage & cleanup
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close cleanup"
          aria-label="Close cleanup"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-2">
        {diskLoading && !disk ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground/70">
            Measuring disk usage…
          </div>
        ) : diskError && !disk ? (
          <div className="break-words py-6 text-center text-[11px] text-destructive">
            {diskError}
          </div>
        ) : disk ? (
          ROWS.map((row) => (
            <div
              key={row.target}
              className="rounded-md border border-border/40 px-2 py-1.5"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-medium text-foreground">
                  {row.label}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {row.size(disk)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <span className="truncate text-[10px] text-muted-foreground/70">
                  reclaimable: {row.reclaimable(disk)}
                  {row.optionLabel ? ` · ${row.optionLabel}` : ""}
                </span>
                {confirming === row.target ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={pruning !== null}
                      onClick={() => runPrune(row.target, row.options)}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      {pruning === row.target ? "Pruning…" : "Confirm"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={pruning !== null}
                    onClick={() => runPrune(row.target, row.options)}
                    title={`Prune ${row.label}`}
                    aria-label={`Prune ${row.label}`}
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground",
                      pruning !== null && "opacity-50",
                    )}
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
                  </button>
                )}
              </div>
            </div>
          ))
        ) : null}
        {pruneOutput ? (
          <div className="mt-1 rounded-md bg-accent/50 p-2">
            <div className="flex items-start justify-between gap-2">
              <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-foreground/80">
                {pruneOutput}
              </pre>
              <button
                type="button"
                onClick={() => clearPruneOutput(hostId)}
                aria-label="Dismiss prune output"
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
