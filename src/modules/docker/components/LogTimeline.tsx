import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { ansiSpans, stripAnsi } from "../lib/ansi";
import {
  classifyLogLevel,
  extractTimestamp,
  type LogLevel,
} from "../lib/logLevels";

export type TimelineRow = {
  /** Stable row key (index + length hash). */
  key: string;
  line: string;
  level: LogLevel;
  ts: string | null;
};

const ROW_H = 22;

/** Windowed log body: renders only the viewport slice of up to 5000 lines,
 *  so a chatty container never costs more than ~40 DOM rows. Overscan keeps
 *  fast scrolls covered; the spacer preserves the scrollbar. */
export function LogTimeline({
  lines,
  highlight,
  wrap,
  fontSize,
  follow,
  onAtBottomChange,
  scrollToken,
}: {
  lines: string[];
  highlight: RegExp | null;
  wrap: boolean;
  fontSize: number;
  /** True while live-following (auto-stick to bottom). */
  follow: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Bump to force a jump to bottom (e.g. after unpause). */
  scrollToken?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const atBottomRef = useRef(true);

  const rows: TimelineRow[] = useMemo(
    () =>
      lines.map((line, i) => ({
        // Append-only buffer: index + length is stable for the row's life.
        key: `${i}-${line.length}`,
        line,
        level: classifyLogLevel(line),
        ts: extractTimestamp(line),
      })),
    [lines],
  );

  const setAtBottom = (v: boolean) => {
    if (atBottomRef.current === v) return;
    atBottomRef.current = v;
    onAtBottomChange?.(v);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickRef.current = nearBottom;
    setAtBottom(nearBottom);
  };

  // Live tick: stick to bottom when following and the user hasn't scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow && stickRef.current) el.scrollTop = el.scrollHeight;
    // stickRef/setAtBottom are refs + stable optional callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, follow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && scrollToken !== undefined) {
      stickRef.current = true;
      el.scrollTop = el.scrollHeight;
      setAtBottom(true);
    }
    // Only the token drives this jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToken]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-label="Container logs"
      className="min-h-0 flex-1 overflow-auto bg-black/[0.82] py-1.5 font-mono"
      style={{ fontSize, lineHeight: 1.5 }}
    >
      <WindowedRows
        rows={rows}
        highlight={highlight}
        wrap={wrap}
        scrollRef={scrollRef}
      />
    </div>
  );
}

function WindowedRows({
  rows,
  highlight,
  wrap,
  scrollRef,
}: {
  rows: TimelineRow[];
  highlight: RegExp | null;
  wrap: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const scrollTop = useScrollTop(scrollRef);

  const { start, end, topPad, bottomPad } = useMemo(() => {
    const el = scrollRef.current;
    const viewport = el?.clientHeight ?? 600;
    if (wrap) {
      // Wrapped rows vary in height: render generously around the viewport.
      const approx = Math.max(0, Math.floor((scrollTop - viewport) / ROW_H));
      const count = Math.ceil((viewport * 3) / ROW_H) + 20;
      const start = Math.max(0, approx);
      const end = Math.min(rows.length, start + count);
      return { start, end, topPad: 0, bottomPad: 0 };
    }
    const overscan = Math.ceil(viewport / ROW_H) + 10;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan);
    const end = Math.min(
      rows.length,
      Math.ceil((scrollTop + viewport) / ROW_H) + overscan,
    );
    return {
      start,
      end,
      topPad: start * ROW_H,
      bottomPad: (rows.length - end) * ROW_H,
    };
  }, [rows.length, scrollTop, wrap, scrollRef]);

  const slice = rows.slice(start, end);
  return (
    <div className={wrap ? undefined : "min-w-max"}>
      {topPad > 0 ? <div style={{ height: topPad }} aria-hidden /> : null}
      {slice.map((r) => (
        <TimelineLine key={r.key} row={r} highlight={highlight} wrap={wrap} />
      ))}
      {bottomPad > 0 ? <div style={{ height: bottomPad }} aria-hidden /> : null}
    </div>
  );
}

/** Live scrollTop of the timeline viewport, coalesced per frame. */
function useScrollTop(
  scrollRef: React.RefObject<HTMLDivElement | null>,
): number {
  const [top, setTop] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const bump = () => {
      cancelAnimationFrame(raf);
      const node = scrollRef.current;
      raf = requestAnimationFrame(() => setTop(node ? node.scrollTop : 0));
    };
    bump();
    el.addEventListener("scroll", bump, { passive: true });
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", bump);
      ro.disconnect();
    };
  }, [scrollRef]);
  return top;
}

const LEVEL_DOT: Record<LogLevel, string | null> = {
  error: "bg-red-500",
  warn: "bg-amber-400",
  info: "bg-sky-400",
  debug: "bg-violet-400",
  trace: "bg-neutral-500",
  plain: null,
};

function TimelineLine({
  row,
  highlight,
  wrap,
}: {
  row: TimelineRow;
  highlight: RegExp | null;
  wrap: boolean;
}) {
  const dot = LEVEL_DOT[row.level];
  const spans = ansiSpans(stripTimestampPreserveAnsi(row.line));
  return (
    <div
      className={cn(
        "group flex items-baseline gap-2 px-3",
        wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
        !wrap && "pr-6",
      )}
      style={wrap ? undefined : { height: ROW_H }}
    >
      <span className="flex w-24 shrink-0 items-baseline gap-1.5 self-start pt-[3px] select-none">
        {dot ? (
          <span
            className={cn(
              "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
              dot,
            )}
          />
        ) : null}
        {row.ts ? (
          <span className="truncate text-[0.85em] tabular-nums text-neutral-500">
            {shortTs(row.ts)}
          </span>
        ) : null}
      </span>
      <span className="min-w-0 flex-1 text-neutral-200">
        {highlight ? (
          <PlainSpans spans={spans} highlight={highlight} />
        ) : (
          <PlainSpans spans={spans} highlight={null} />
        )}
      </span>
    </div>
  );
}

/** Positional ANSI segments with stable content-derived keys. */
function PlainSpans({
  spans,
  highlight,
}: {
  spans: { text: string; className: string | null }[];
  highlight: RegExp | null;
}) {
  return (
    <>
      {spans.map((s, i) => {
        // Index keys are safe: segments are positional within one line.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional ANSI segments
        const key = `${i}-${s.text.length}`;
        if (highlight) {
          return (
            <HighlightText
              key={key}
              text={s.text}
              className={s.className}
              re={highlight}
            />
          );
        }
        return s.className ? (
          <span key={key} className={s.className}>
            {s.text}
          </span>
        ) : (
          <span key={key}>{s.text}</span>
        );
      })}
    </>
  );
}

/** Strip the timestamp prefix but keep ANSI runs intact: find the raw
 *  index just past the timestamp's printable chars (SGR skipped), then
 *  drop leading whitespace. SGR opens before the cut survive, so colors
 *  persist across the cut. */
function stripTimestampPreserveAnsi(line: string): string {
  const ts = extractTimestamp(line);
  if (!ts) return line;
  const plain = stripAnsi(line);
  const idx = plain.indexOf(ts);
  if (idx < 0) return line;
  const cut = rawIndexPast(line, idx + ts.length);
  return line.slice(cut).trimStart();
}

/** Raw string index past the first `target` printable chars (SGR skipped). */
function rawIndexPast(line: string, target: number): number {
  // eslint-disable-next-line no-control-regex
  const runs = [...line.matchAll(/\u001b\[[0-9;]*m/g)];
  let printable = 0;
  let last = 0;
  for (const m of runs) {
    const gap = (m.index ?? 0) - last;
    if (printable + gap >= target) return last + (target - printable);
    printable += gap;
    last = (m.index ?? 0) + m[0].length;
  }
  return Math.min(line.length, last + (target - printable));
}

function shortTs(ts: string): string {
  const m = /T?(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : ts.slice(0, 8);
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
    if (m.index > last)
      parts.push({ text: text.slice(last, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) fresh.lastIndex = last + 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  const keyed = parts.map((p, i) => ({ ...p, key: `${i}-${p.text.length}` }));
  return (
    <span className={className ?? undefined}>
      <MatchParts parts={keyed} />
    </span>
  );
}

/** Positional match fragments with stable content-derived keys. */
function MatchParts({
  parts,
}: {
  parts: { text: string; hit: boolean; key: string }[];
}) {
  return (
    <>
      {parts.map((p) =>
        // Index keys are safe: fragments are positional within one line.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional match fragments
        p.hit ? (
          <mark key={p.key} className="rounded-sm bg-amber-400/40 text-inherit">
            {p.text}
          </mark>
        ) : (
          <span key={p.key}>{p.text}</span>
        ),
      )}
    </>
  );
}
