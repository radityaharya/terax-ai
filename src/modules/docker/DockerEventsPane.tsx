import { cn } from "@/lib/utils";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { stripAnsi } from "./lib/ansi";
import { useDockerStore } from "./lib/dockerStore";
import type { DockerEvent } from "./lib/dockerStore";

type Props = {
  hostId: string;
  onClose: () => void;
};

const RULES = [
  { kind: "died", label: "Container died" },
  { kind: "unhealthy", label: "Unhealthy" },
  { kind: "oom", label: "OOM killed" },
  { kind: "update", label: "Image updates" },
  { kind: "underReplicated", label: "Under-replicated" },
];

/** `docker events` activity feed with per-host notification rule mutes. */
export function DockerEventsPane({ hostId, onClose }: Props) {
  const feed = useDockerStore((s) => s.byHost[hostId]?.eventsFeed ?? null);
  const mute = useDockerStore((s) => s.byHost[hostId]?.notifyMute ?? {});
  const startEventsFeed = useDockerStore((s) => s.startEventsFeed);
  const pollEventsFeed = useDockerStore((s) => s.pollEventsFeed);
  const stopEventsFeed = useDockerStore((s) => s.stopEventsFeed);
  const setRuleMuted = useDockerStore((s) => s.setRuleMuted);
  const [filter, setFilter] = useState("");

  const phase = feed?.phase;
  useEffect(() => {
    void startEventsFeed(hostId);
    return () => {
      void stopEventsFeed(hostId);
    };
  }, [hostId, startEventsFeed, stopEventsFeed]);

  useEffect(() => {
    if (phase !== "streaming") return;
    const t = setInterval(() => {
      void pollEventsFeed(hostId);
    }, 2000);
    return () => clearInterval(t);
  }, [hostId, phase, pollEventsFeed]);

  const visible = useMemo(() => {
    const events = [...(feed?.events ?? [])].reverse();
    const q = filter.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) => eventText(e).toLowerCase().includes(q));
  }, [feed?.events, filter]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l border-border/60 bg-background shadow-xl"
      role="dialog"
      aria-label="Docker events"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          Events
        </span>
        <EventPill phase={feed?.phase ?? "starting"} />
        <button
          type="button"
          onClick={onClose}
          title="Close events"
          aria-label="Close events"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
        </button>
      </div>
      <div className="shrink-0 border-b border-border/60 px-2.5 py-1.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          Notify on
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {RULES.map((r) => {
            const muted = mute[r.kind] ?? false;
            return (
              <button
                key={r.kind}
                type="button"
                onClick={() => setRuleMuted(hostId, r.kind, !muted)}
                aria-pressed={!muted}
                title={muted ? `Unmute ${r.label}` : `Mute ${r.label}`}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
                  muted
                    ? "text-muted-foreground/60 line-through hover:text-foreground"
                    : "bg-accent text-foreground",
                )}
              >
                {r.label}
              </button>
            );
          })}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter events"
          className="mt-1.5 h-6 w-full rounded border border-border/60 bg-background px-1.5 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {feed?.phase === "error" ? (
          <div className="break-words py-6 text-center text-[11px] text-destructive">
            {feed.error}
          </div>
        ) : visible.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground/70">
            {feed?.phase === "starting" ? "Attaching to events…" : "No events yet."}
          </div>
        ) : (
          // Event stream is append-only, capped at 500: positional keys.
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only event stream
          visible.map((e, i) => <EventRow key={`${i}-${e.timeNano ?? e.time ?? ""}`} event={e} />)
        )}
      </div>
    </div>
  );
}

function EventPill({ phase }: { phase: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
        phase === "streaming" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        (phase === "done" || phase === "error") && "bg-accent text-muted-foreground",
        phase === "starting" && "bg-accent text-muted-foreground",
      )}
    >
      {phase}
    </span>
  );
}

function eventText(e: DockerEvent): string {
  const attrs = e.Actor?.Attributes ?? {};
  return [e.Type, e.Action, attrs.name, e.Actor?.ID, attrs.image, attrs.exitCode]
    .filter(Boolean)
    .join(" ");
}

function EventRow({ event }: { event: DockerEvent }) {
  const attrs = event.Actor?.Attributes ?? {};
  const name = attrs.name ?? event.Actor?.ID?.slice(0, 12) ?? "?";
  const action = String(event.Action ?? "");
  const tone =
    action === "die" || action === "oom" || action.includes("unhealthy")
      ? "text-destructive"
      : action === "start" || action === "create"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-foreground/90";
  return (
    <div className="flex items-baseline gap-1.5 rounded px-1.5 py-1 text-[11px] hover:bg-accent/50">
      <span className="shrink-0 rounded bg-accent px-1 py-px font-mono text-[10px] text-muted-foreground">
        {String(event.Type ?? "?")}
      </span>
      <span className={cn("shrink-0 font-medium", tone)}>{action}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{stripAnsi(name)}</span>
      {attrs.exitCode ? (
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          exit {attrs.exitCode}
        </span>
      ) : null}
    </div>
  );
}
