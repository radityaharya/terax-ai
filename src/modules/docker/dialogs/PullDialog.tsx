import { cn } from "@/lib/utils";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef } from "react";
import { useDockerStore } from "../lib/dockerStore";
import type { PullProgressEvent } from "../lib/types";

type Props = {
  hostId: string;
  jobId: string;
  onClose: () => void;
};

/** Live `docker pull` progress: layered events + raw fallback. */
export function PullDialog({ hostId, jobId, onClose }: Props) {
  const job = useDockerStore((s) => s.byHost[hostId]?.pulls[jobId] ?? null);
  const pollPull = useDockerStore((s) => s.pollPull);
  const cancelPull = useDockerStore((s) => s.cancelPull);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!job || job.phase === "done" || job.phase === "error") return;
    const t = setInterval(() => {
      void pollPull(hostId, jobId);
    }, 1000);
    return () => clearInterval(t);
  }, [hostId, jobId, job?.phase, pollPull]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job?.output, job?.events.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!job) return null;

  const layers = layerSummary(job.events);
  const running = job.phase === "starting" || job.phase === "pulling";

  return (
    <div
      className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l border-border/60 bg-background shadow-xl"
      role="dialog"
      aria-label={`Pull ${job.reference}`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          Pull {job.reference}
        </span>
        <StatusPill phase={job.phase} />
        <button
          type="button"
          onClick={onClose}
          title="Close pull progress"
          aria-label="Close pull progress"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
        </button>
      </div>
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 py-2">
        {job.platform ? (
          <div className="text-[10px] text-muted-foreground/70">platform: {job.platform}</div>
        ) : null}
        {layers.length > 0 ? (
          <div className="flex flex-col gap-1">
            {layers.map((l) => (
              <div key={l.id} className="flex items-baseline gap-2 text-[11px]">
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                  {l.id.slice(0, 8)}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground/90">{l.status}</span>
                {l.detail ? (
                  <span className="shrink-0 tabular-nums text-muted-foreground/70">{l.detail}</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {job.digest ? (
          <div className="break-all font-mono text-[10px] text-muted-foreground/70">
            digest: {job.digest}
          </div>
        ) : null}
        {job.error ? (
          <div className="break-words text-[11px] text-destructive">{job.error}</div>
        ) : null}
        {!job.quiet ? (
          <details>
            <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
              Raw output
            </summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-accent/50 p-2 font-mono text-[10px] leading-relaxed text-foreground/80">
              {job.output || "(waiting for output…)"}
            </pre>
          </details>
        ) : null}
        {job.dropped > 0 ? (
          <div className="text-[10px] text-amber-600 dark:text-amber-400">
            {job.dropped} bytes dropped from the ring buffer — showing latest.
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-border/60 px-2.5 py-2">
        {running ? (
          <button
            type="button"
            onClick={() => void cancelPull(hostId, jobId)}
            className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Cancel pull
          </button>
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}

function StatusPill({ phase }: { phase: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
        phase === "done" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        phase === "error" && "bg-destructive/10 text-destructive",
        (phase === "pulling" || phase === "starting") && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      )}
    >
      {phase === "starting" ? "starting…" : phase === "pulling" ? "pulling…" : phase}
    </span>
  );
}

type LayerRow = { id: string; status: string; detail: string };

/** Latest status per layer id, in first-seen order. */
function layerSummary(events: PullProgressEvent[]): LayerRow[] {
  const order: string[] = [];
  const byId = new Map<string, LayerRow>();
  for (const ev of events) {
    if (ev.kind !== "layer") continue;
    if (!byId.has(ev.id)) order.push(ev.id);
    byId.set(ev.id, { id: ev.id, status: ev.status, detail: ev.detail });
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}
