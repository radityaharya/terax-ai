import { cn } from "@/lib/utils";
import { Cancel01Icon, CopyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ansiSpans, stripAnsi } from "./lib/ansi";
import { useDockerStore } from "./lib/dockerStore";

type Props = {
  hostId: string;
  kind: "container" | "service";
  id: string;
  title: string;
  onClose: () => void;
  /** Render inline (tab surface) instead of as a floating drawer. */
  inline?: boolean;
};

const TAIL_CHOICES = [100, 500, 1000, 5000];

/** Live `docker logs -f` follow: virtualization-friendly row cap,
 *  pause-on-scroll, regex filter/highlight, timestamps/tail/since, export. */
export function DockerLogsPane({ hostId, kind, id, title, onClose, inline }: Props) {
  const followId = `${kind}:${id}`;
  const follow = useDockerStore((s) => s.byHost[hostId]?.logFollows[followId] ?? null);
  const startLogFollow = useDockerStore((s) => s.startLogFollow);
  const pollLogFollow = useDockerStore((s) => s.pollLogFollow);
  const stopLogFollow = useDockerStore((s) => s.stopLogFollow);
  const setLogOptions = useDockerStore((s) => s.setLogOptions);

  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState("");
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const phase = follow?.phase;

  useEffect(() => {
    // Tab surfaces own their follow lifecycle (see DockerLogsTabPane);
    // the pane only starts one when rendered standalone (drawer).
    if (inline) return;
    const fid = `${kind}:${id}`;
    startLogFollow(hostId, kind, id);
    return () => {
      void stopLogFollow(hostId, fid);
    };
  }, [hostId, kind, id, inline, startLogFollow, stopLogFollow]);

  useEffect(() => {
    if (phase !== "following" && phase !== "starting") return;
    if (paused) return;
    const t = setInterval(() => {
      void pollLogFollow(hostId, followId);
    }, 1500);
    return () => clearInterval(t);
  }, [hostId, followId, phase, paused, pollLogFollow]);

  const highlightRe = useMemo(() => {
    if (!highlight.trim()) return null;
    try {
      return new RegExp(highlight, "i");
    } catch {
      return null;
    }
  }, [highlight]);

  const visible = useMemo(() => {
    const lines = follow?.lines ?? [];
    const q = filter.trim();
    if (!q) return lines;
    let re: RegExp | null = null;
    try {
      re = new RegExp(q, "i");
    } catch {
      const lower = q.toLowerCase();
      return lines.filter((l) => stripAnsi(l).toLowerCase().includes(lower));
    }
    const rx = re;
    return lines.filter((l) => rx.test(stripAnsi(l)));
  }, [follow?.lines, filter]);

  const visibleCount = visible.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current && !paused) el.scrollTop = el.scrollHeight;
  }, [visibleCount, paused]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(visible.map(stripAnsi).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  const saveToFile = async () => {
    const text = visible.map(stripAnsi).join("\n");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Write next to the remote home: the agent resolves relative paths
      // against its authorized root.
      const safe = title.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 64) || "docker";
      await invoke("ssh_rpc", {
        hostId,
        method: "fs_write_file",
        params: { path: `${safe}-${Date.now()}.log`, content: text },
      });
    } catch {
      // fall back to clipboard
      await copyAll();
    }
  };

  const opts = follow?.options;

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: drawer uses dialog role; inline tab surface carries the tab label
    <div
      className={
        inline
          ? "flex h-full w-full flex-col bg-background"
          : "absolute inset-y-0 right-0 z-20 flex w-[26rem] max-w-[90%] flex-col border-l border-border/60 bg-background shadow-xl"
      }
      role={inline ? undefined : "dialog"}
      aria-label={`Logs: ${title}`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          Logs · {title}
        </span>
        <FollowPill phase={follow?.phase ?? "starting"} paused={paused} />
        <button
          type="button"
          onClick={() => void copyAll()}
          title={copied ? "Copied" : "Copy visible logs"}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={CopyIcon} size={13} strokeWidth={1.75} />
        </button>
        {inline ? null : (
          <button
            type="button"
            onClick={onClose}
            title="Close logs"
            aria-label="Close logs"
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
          </button>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setPaused((v) => !v)}
          aria-pressed={paused}
          title={paused ? "Resume follow" : "Pause follow (freeze scroll)"}
          className={cn(
            "h-6 rounded-md px-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
            paused ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={() => setWrap((v) => !v)}
          aria-pressed={wrap}
          title="Toggle line wrap"
          className={cn(
            "h-6 rounded-md px-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
            wrap ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          Wrap
        </button>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={opts?.timestamps ?? true}
            onChange={(e) => setLogOptions(hostId, followId, { timestamps: e.target.checked })}
          />
          Times
        </label>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          Tail
          <select
            value={opts?.tail ?? 500}
            onChange={(e) => setLogOptions(hostId, followId, { tail: Number(e.target.value) })}
            className="h-6 rounded border border-border/60 bg-background px-1 text-[11px] outline-none"
          >
            {TAIL_CHOICES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter (regex)"
          title="Filter lines (regex, case-insensitive)"
          className="h-6 min-w-0 flex-1 rounded border border-border/60 bg-background px-1.5 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
        />
        <input
          value={highlight}
          onChange={(e) => setHighlight(e.target.value)}
          placeholder="Highlight"
          title="Highlight matches"
          className="h-6 w-20 rounded border border-border/60 bg-background px-1.5 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
        />
        <button
          type="button"
          onClick={() => void saveToFile()}
          title="Export visible logs to a file"
          className="h-6 rounded-md px-2 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Export
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto bg-black/80 px-2.5 py-2 font-mono text-[11px] leading-[1.45] text-neutral-200"
      >
        {follow?.phase === "error" ? (
          <div className="text-red-400">{follow.error}</div>
        ) : visible.length === 0 ? (
          <div className="text-neutral-500">
            {follow?.phase === "starting" ? "Attaching to logs…" : "No log lines yet."}
          </div>
        ) : (
          visible.map((line, i) => (
            // Index keys are safe: log lines are append-only, capped at 5000.
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only log buffer
            <LogLine key={`${i}-${line.length}`} line={line} highlight={highlightRe} wrap={wrap} />
          ))
        )}
        {follow && follow.dropped > 0 ? (
          <div className="text-amber-400">…{follow.dropped} bytes dropped from buffer…</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-border/60 px-2.5 py-1 text-[10px] text-muted-foreground/70">
        <span>
          {visible.length} lines
          {follow?.exited ? ` · exited ${follow.exitCode ?? "?"}` : ""}
        </span>
        {!stickRef.current && !paused ? (
          <button
            type="button"
            onClick={() => {
              stickRef.current = true;
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className="text-primary hover:underline"
          >
            Jump to bottom
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FollowPill({ phase, paused }: { phase: string; paused: boolean }) {
  const label = paused ? "paused" : phase === "following" ? "following" : phase;
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
        label === "following" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        label === "paused" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        (label === "done" || label === "error") && "bg-accent text-muted-foreground",
        label === "starting" && "bg-accent text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function LogLine({
  line,
  highlight,
  wrap,
}: {
  line: string;
  highlight: RegExp | null;
  wrap: boolean;
}) {
  const spans = ansiSpans(line);
  // ANSI spans are positional within a line: stable content-derived keys.
  // biome-ignore lint/suspicious/noArrayIndexKey: positional ANSI segments
  const keyed = spans.map((s, i) => ({ ...s, key: `${i}-${s.text.length}` }));
  if (!highlight) {
    return (
      <div className={wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}>
        {keyed.map((s) =>
          s.className ? (
            <span key={s.key} className={s.className}>
              {s.text}
            </span>
          ) : (
            <span key={s.key}>{s.text}</span>
          ),
        )}
      </div>
    );
  }
  // Highlight pass over plain text, preserving ANSI colors per segment.
  return (
    <div className={wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}>
      {keyed.map((s) => (
        <HighlightText key={s.key} text={s.text} className={s.className} re={highlight} />
      ))}
    </div>
  );
}

function HighlightText({
  text,
  className,
  re,
}: {
  text: string;
  className: string | null;
  re: RegExp;
}) {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const fresh = new RegExp(re.source, flags);
  const parts: { text: string; hit: boolean }[] = [];
  let last = 0;
  let guard = 0;
  for (;;) {
    guard++;
    if (guard > text.length + 10) break;
    const m: RegExpExecArray | null = fresh.exec(text);
    if (m === null) break;
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) fresh.lastIndex = last + 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  const keyedParts = parts.map((p, i) => ({ ...p, key: `${i}-${p.text.length}` }));
  return (
    <span className={className ?? undefined}>
      {keyedParts.map((p) =>
        // Match fragments are positional: stable content-derived keys.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional match fragments
        p.hit ? (
          <mark key={p.key} className="rounded-sm bg-amber-400/40 text-inherit">
            {p.text}
          </mark>
        ) : (
          <span key={p.key}>{p.text}</span>
        ),
      )}
    </span>
  );
}
