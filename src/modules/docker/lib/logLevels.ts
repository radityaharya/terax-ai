import { stripAnsi } from "./ansi";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace" | "plain";

const LEVEL_RE =
  /\b(fatal|error|err|fail(?:ed|ure)?|exception|panic|critical|crit|warn(?:ing)?|info|debug|trace|verbose)\b/i;

/** Classify one log line into a level bucket for the inspector filters. */
export function classifyLogLevel(line: string): LogLevel {
  const text = stripAnsi(line);
  const m = LEVEL_RE.exec(text);
  if (!m) return "plain";
  const w = m[1].toLowerCase();
  if (w === "fatal" || w === "error" || w === "err" || w.startsWith("fail") || w === "exception" || w === "panic" || w === "critical" || w === "crit") {
    return "error";
  }
  if (w.startsWith("warn")) return "warn";
  if (w === "debug") return "debug";
  if (w === "trace" || w === "verbose") return "trace";
  return "info";
}

/** Leading ISO/RFC3339-ish timestamp when the line carries one. */
const TS_RE =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

export function extractTimestamp(line: string): string | null {
  const m = TS_RE.exec(stripAnsi(line).trimStart());
  return m ? m[1] : null;
}

/** Body with the leading timestamp removed (when present). */
export function stripTimestamp(line: string): string {
  const ts = extractTimestamp(line);
  if (!ts) return line;
  const plain = stripAnsi(line);
  const idx = plain.indexOf(ts);
  if (idx < 0) return line;
  return plain.slice(idx + ts.length).trimStart();
}

export const LEVEL_ORDER: LogLevel[] = ["error", "warn", "info", "debug", "trace", "plain"];
