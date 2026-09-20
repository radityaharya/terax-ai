import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  CopyIcon,
  Download01Icon,
  PauseIcon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LEVEL_ORDER, type LogLevel } from "../lib/logLevels";

const TAIL_CHOICES = [100, 500, 1000, 5000];

export type InspectorState = {
  filter: string;
  highlight: string;
  paused: boolean;
  wrap: boolean;
  fontSize: number;
  timestamps: boolean;
  tail: number;
  since: string;
  levels: Record<LogLevel, boolean>;
  counts: Record<LogLevel, number>;
  atBottom: boolean;
  phase: string;
  lineCount: number;
  dropped: number;
  exited: boolean;
  exitCode: number | null;
  copied: boolean;
};

export type InspectorActions = {
  setFilter: (v: string) => void;
  setHighlight: (v: string) => void;
  setPaused: (v: boolean) => void;
  setWrap: (v: boolean) => void;
  bumpFont: (d: number) => void;
  setTimestamps: (v: boolean) => void;
  setTail: (v: number) => void;
  setSince: (v: string) => void;
  toggleLevel: (l: LogLevel) => void;
  onlyLevel: (l: LogLevel | null) => void;
  onCopy: () => void;
  onExport: () => void;
  onJumpBottom: () => void;
};

const LEVEL_STYLE: Record<LogLevel, { dot: string; label: string }> = {
  error: { dot: "bg-red-500", label: "Errors" },
  warn: { dot: "bg-amber-400", label: "Warnings" },
  info: { dot: "bg-sky-400", label: "Info" },
  debug: { dot: "bg-violet-400", label: "Debug" },
  trace: { dot: "bg-neutral-500", label: "Trace" },
  plain: { dot: "bg-neutral-600", label: "Plain" },
};

/** Right-hand inspector rail for the logs tab: search, level buckets,
 *  stream controls, source options, export. Collapses under 640px. */
export function LogsInspector({
  s,
  a,
}: {
  s: InspectorState;
  a: InspectorActions;
}) {
  return (
    <aside
      aria-label="Log inspector"
      className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border/60 bg-background px-3 py-3 max-[640px]:hidden"
    >
      <section aria-label="Search">
        <RailLabel>Search</RailLabel>
        <input
          value={s.filter}
          onChange={(e) => a.setFilter(e.target.value)}
          placeholder="Filter lines (regex)"
          title="Filter lines (regex, case-insensitive)"
          className="h-7 w-full rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
        />
        <input
          value={s.highlight}
          onChange={(e) => a.setHighlight(e.target.value)}
          placeholder="Highlight matches"
          title="Highlight matches"
          className="mt-1.5 h-7 w-full rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
        />
      </section>

      <section aria-label="Levels">
        <RailLabel>Levels</RailLabel>
        <ul className="flex flex-col gap-0.5">
          {LEVEL_ORDER.map((l) => {
            const on = s.levels[l];
            return (
              <li key={l}>
                <button
                  type="button"
                  onClick={() => a.toggleLevel(l)}
                  onDoubleClick={() => a.onlyLevel(l)}
                  aria-pressed={on}
                  title={`${LEVEL_STYLE[l].label} — click to toggle, double-click to isolate`}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
                    on
                      ? "text-foreground hover:bg-accent/60"
                      : "text-muted-foreground/50 hover:bg-accent/40",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      LEVEL_STYLE[l].dot,
                      !on && "opacity-30",
                    )}
                  />
                  <span className="flex-1 text-left font-medium">
                    {LEVEL_STYLE[l].label}
                  </span>
                  <span className="tabular-nums text-muted-foreground/60">
                    {s.counts[l] > 999
                      ? `${(s.counts[l] / 1000).toFixed(1)}k`
                      : s.counts[l]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={() => a.onlyLevel(null)}
          className="mt-1 px-1.5 text-[10px] text-muted-foreground/70 hover:text-foreground hover:underline"
        >
          Reset levels
        </button>
      </section>

      <section aria-label="Stream">
        <RailLabel>Stream</RailLabel>
        <div className="flex flex-col gap-1">
          <RailButton
            onClick={() => a.setPaused(!s.paused)}
            icon={
              s.paused ? (
                <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.75} />
              ) : (
                <HugeiconsIcon icon={PauseIcon} size={13} strokeWidth={1.75} />
              )
            }
          >
            {s.paused ? "Resume follow" : "Pause follow"}
          </RailButton>
          <RailButton
            onClick={a.onJumpBottom}
            disabled={s.atBottom}
            icon={
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            Jump to live tail
          </RailButton>
          <label className="flex cursor-pointer items-center justify-between rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground">
            <span className="font-medium">Line wrap</span>
            <input
              type="checkbox"
              checked={s.wrap}
              onChange={(e) => a.setWrap(e.target.checked)}
              className="accent-primary"
            />
          </label>
          <div className="flex items-center justify-between rounded-md px-1.5 py-1 text-[11px] text-muted-foreground">
            <span className="font-medium">Text size</span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => a.bumpFont(-1)}
                aria-label="Decrease log text size"
                className="flex size-5 items-center justify-center rounded hover:bg-accent hover:text-foreground"
              >
                −
              </button>
              <span className="w-6 text-center tabular-nums">{s.fontSize}</span>
              <button
                type="button"
                onClick={() => a.bumpFont(1)}
                aria-label="Increase log text size"
                className="flex size-5 items-center justify-center rounded hover:bg-accent hover:text-foreground"
              >
                +
              </button>
            </span>
          </div>
        </div>
      </section>

      <section aria-label="Source">
        <RailLabel>Source</RailLabel>
        <div className="flex flex-col gap-1.5 px-1.5">
          <label className="flex cursor-pointer items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-medium">Timestamps</span>
            <input
              type="checkbox"
              checked={s.timestamps}
              onChange={(e) => a.setTimestamps(e.target.checked)}
              className="accent-primary"
            />
          </label>
          <label className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-medium">Tail</span>
            <select
              value={s.tail}
              onChange={(e) => a.setTail(Number(e.target.value))}
              className="h-6 rounded border border-border/60 bg-background px-1 text-[11px] outline-none"
            >
              {TAIL_CHOICES.map((t) => (
                <option key={t} value={t}>
                  {t} lines
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            <span className="font-medium">Since</span>
            <input
              value={s.since}
              onChange={(e) => a.setSince(e.target.value)}
              placeholder="e.g. 2h, 2026-09-20"
              title="Docker --since filter (respawns the follow)"
              className="h-6 rounded border border-border/60 bg-background px-1.5 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
            />
          </label>
        </div>
      </section>

      <section aria-label="Export">
        <RailLabel>Export</RailLabel>
        <div className="flex flex-col gap-1">
          <RailButton
            onClick={a.onCopy}
            icon={
              <HugeiconsIcon icon={CopyIcon} size={13} strokeWidth={1.75} />
            }
          >
            {s.copied ? "Copied" : "Copy visible"}
          </RailButton>
          <RailButton
            onClick={a.onExport}
            icon={
              <HugeiconsIcon
                icon={Download01Icon}
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            Save to host file
          </RailButton>
        </div>
      </section>

      <p className="mt-auto px-1.5 pt-2 text-[10px] leading-relaxed text-muted-foreground/60">
        {s.lineCount} lines
        {s.exited ? ` · exited ${s.exitCode ?? "?"}` : ""}
        {s.dropped > 0 ? ` · ${s.dropped} bytes dropped` : ""}
      </p>
    </aside>
  );
}

function RailLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
      {children}
    </h3>
  );
}

function RailButton({
  children,
  onClick,
  icon,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      {children}
    </button>
  );
}

export function LogsCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      title="Close logs"
      aria-label="Close logs"
      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
    </button>
  );
}
