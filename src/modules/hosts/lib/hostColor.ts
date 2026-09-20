import type { CSSProperties } from "react";

/**
 * Recommended host accents. Chosen from the 400-weight ramp so they read as
 * vivid dots on the dark pane surface and still hold up as chip tint on the
 * light theme; the picker offers these first and a free hex/native picker
 * after them.
 */
export const HOST_COLOR_PALETTE: { name: string; hex: string }[] = [
  { name: "Sky", hex: "#38bdf8" },
  { name: "Violet", hex: "#a78bfa" },
  { name: "Emerald", hex: "#34d399" },
  { name: "Amber", hex: "#fbbf24" },
  { name: "Rose", hex: "#fb7185" },
  { name: "Orange", hex: "#fb923c" },
  { name: "Teal", hex: "#2dd4bf" },
  { name: "Indigo", hex: "#818cf8" },
  { name: "Lime", hex: "#a3e635" },
  { name: "Fuchsia", hex: "#e879f9" },
];

/**
 * Canonicalize user input to `#rrggbb`, or `null` when it isn't a color.
 * Accepts an optional leading `#` and 3- or 6-digit hex, mirroring the Rust
 * `normalize_host_color` so the form and the store agree on what's valid.
 */
export function normalizeHostColor(
  raw: string | null | undefined,
): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  const expanded =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return null;
  return `#${expanded.toLowerCase()}`;
}

/**
 * Stable "auto" color for a host: same host id always lands on the same
 * palette entry, so existing hosts get a distinct recommendation without
 * anyone opening the editor, and it survives a reload.
 */
export function suggestHostColor(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return HOST_COLOR_PALETTE[hash % HOST_COLOR_PALETTE.length].hex;
}

/**
 * Mirrors the Rust `host_id_for` slug so the editor can preview the exact
 * auto color a brand-new host will get once the backend derives its id.
 * Pinned to the Rust test vectors in `hostColor.test.ts`.
 */
export function hostIdSeed(alias: string): string {
  const slugged = alias
    .trim()
    .toLowerCase()
    .split("")
    .map((c) => (/[a-z0-9]/.test(c) || /[._\- ]/.test(c) ? c : "-"))
    .join("");
  let id = slugged;
  while (id.includes("..")) id = id.split("..").join("-");
  return id.replace(/^[.\-_]+|[.\-_]+$/g, "");
}

/** The color to actually paint: an explicit pick, else the auto suggestion. */
export function resolveHostColor(host: {
  id?: string | null;
  alias?: string | null;
  color?: string | null;
}): string {
  return (
    normalizeHostColor(host.color) ??
    suggestHostColor(host.id || hostIdSeed(host.alias ?? ""))
  );
}

/** Solid dot/fill style. */
export function hostDotStyle(hex: string): CSSProperties {
  return { backgroundColor: hex };
}

/**
 * Tinted chip style: a translucent wash of the accent with matching border
 * and text, so a host reads as a color without a heavy solid block.
 */
export function hostChipStyle(hex: string): CSSProperties {
  return {
    color: hex,
    backgroundColor: `color-mix(in oklab, ${hex} 20%, transparent)`,
    borderColor: `color-mix(in oklab, ${hex} 38%, transparent)`,
  };
}
