/**
 * Docker `stats` formatting + threshold helpers. Pure so the row primitives
 * and any future summary views share one definition of "hot" and one byte
 * formatter.
 */

export type StatTone = "ok" | "warn" | "hot" | "muted";

/** Parse a docker "12.88%"-style percent into a number. */
export function parsePercent(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/([\d.]+)\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function cpuTone(raw: string | undefined): StatTone {
  const n = parsePercent(raw);
  if (n === null) return "muted";
  if (n >= 90) return "hot";
  if (n >= 50) return "warn";
  return "ok";
}

export function memTone(raw: string | undefined): StatTone {
  const n = parsePercent(raw);
  if (n === null) return "muted";
  if (n >= 90) return "hot";
  if (n >= 70) return "warn";
  return "ok";
}

/** "24.94MiB" -> "24.9M", "46.4MB" -> "46.4M", "114.3MiB" -> "114M". */
export function compactBytes(raw: string): string {
  const m = raw.match(/^([\d.]+)\s*([kKmMgGtT])?(i?[bB])?$/);
  if (!m) return raw;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return raw;
  const unit = (m[2] ?? "").toUpperCase();
  const rounded = n >= 100 ? String(Math.round(n)) : n.toFixed(1);
  return unit ? `${rounded}${unit}` : rounded;
}

/** "77.03MiB / 11.68GiB" -> "77.0M"; keeps dashes/empties as-is. */
export function compactUsage(raw: string | undefined): string {
  if (!raw) return "—";
  const first = raw.split("/")[0]?.trim() ?? "";
  return first ? compactBytes(first.replace(/\s+/g, "")) : "—";
}

/** "7.94GB / 6.76GB" -> "7.9G⇕6.8G" (in⇕out, compact units). */
export function compactIO(raw: string | undefined): string {
  if (!raw) return "—";
  const parts = raw
    .split("/")
    .map((p) => compactBytes(p.trim().replace(/\s+/g, "")));
  if (parts.length === 2) return `${parts[0]}⇕${parts[1]}`;
  return parts[0] ?? "—";
}
