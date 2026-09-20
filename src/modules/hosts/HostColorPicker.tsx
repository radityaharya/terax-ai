import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import {
  HOST_COLOR_PALETTE,
  hostChipStyle,
  hostDotStyle,
  normalizeHostColor,
} from "./lib/hostColor";

type Props = {
  /** Explicit pick, or null for "auto". */
  value: string | null;
  /** The color auto would use, so the Auto button can preview it. */
  autoHex: string;
  /** Sample label used by the preview chip (usually the alias). */
  previewLabel: string;
  onChange: (hex: string | null) => void;
};

/**
 * Host accent picker: recommended swatches first (the default answer for
 * almost everyone), then an OS color picker and a hex field for anything
 * else, plus an Auto option that reverts to the id-derived color.
 */
export function HostColorPicker({
  value,
  autoHex,
  previewLabel,
  onChange,
}: Props) {
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const normalized = normalizeHostColor(draft);
  const invalid = draft.trim().length > 0 && normalized === null;
  const activeHex = value ?? autoHex;
  const isAuto = value === null;

  const commitDraft = () => {
    if (!draft.trim()) {
      onChange(null);
      return;
    }
    if (normalized) onChange(normalized);
    else setDraft(value ?? "");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {HOST_COLOR_PALETTE.map((c) => {
          const selected = value === c.hex;
          return (
            <button
              key={c.hex}
              type="button"
              aria-label={`${c.name} (${c.hex})`}
              aria-pressed={selected}
              title={`${c.name} · ${c.hex}`}
              onClick={() => onChange(c.hex)}
              style={hostDotStyle(c.hex)}
              className={cn(
                "size-5 shrink-0 rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-primary/50",
                selected
                  ? "ring-2 ring-foreground/80"
                  : "ring-1 ring-inset ring-black/20",
              )}
            />
          );
        })}

        <label
          title="Custom color…"
          className="relative size-5 shrink-0 cursor-pointer overflow-hidden rounded-full ring-1 ring-inset ring-black/20"
          style={{
            background:
              "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #38bdf8, #a78bfa, #f87171)",
          }}
        >
          <input
            type="color"
            aria-label="Custom color"
            value={activeHex}
            onChange={(e) => onChange(normalizeHostColor(e.target.value) ?? null)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>

        <span className="mx-0.5 h-5 w-px shrink-0 rounded-full bg-border" />

        <button
          type="button"
          aria-pressed={isAuto}
          onClick={() => onChange(null)}
          title={`Auto — ${autoHex}`}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
            isAuto
              ? "bg-foreground/[0.08] text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={hostDotStyle(autoHex)}
          />
          Auto
        </button>

        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft();
            }
          }}
          spellCheck={false}
          aria-label="Hex color"
          aria-invalid={invalid}
          placeholder={autoHex}
          className={cn(
            "h-6 w-20 rounded-md border bg-background px-1.5 font-mono text-[11px] uppercase outline-none placeholder:text-muted-foreground/50",
            invalid
              ? "border-destructive/70 focus:border-destructive"
              : "border-border/60 focus:border-primary/50",
          )}
        />
      </div>

      <div className="flex items-center gap-2">
        <span
          style={hostChipStyle(activeHex)}
          className="max-w-full truncate rounded border px-1.5 py-px text-[10px] font-medium leading-tight"
        >
          {previewLabel || "host"}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {isAuto ? `Auto · ${autoHex}` : activeHex}
        </span>
      </div>
    </div>
  );
}
