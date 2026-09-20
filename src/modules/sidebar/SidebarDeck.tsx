import { cn } from "@/lib/utils";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

export type DeckCard = {
  /** Stable key: opening the same key focuses, a new key replaces. */
  key: string;
  title: string;
  badge?: string;
  actions?: ReactNode;
  body: ReactNode;
  /** Narrow cards (confirm prompts, small forms) center instead of filling. */
  narrow?: boolean;
};

/** Detail surface for sidebar views, rendered in its own real
 *  ResizablePanel next to the list (see useSidebarDeckPanel) — never an
 *  overlay covering the list. One focused card at a time: opening a card
 *  replaces the current one (never piles up); Escape or the close button
 *  returns to the list, collapsing the panel back to 0 width.
 *
 *  Any sidebar view can push a card here: docker inspect/logs/exec, git
 *  commit detail, host auth, explorer previews. */
export function SidebarDeck({
  card,
  onClose,
  onBack,
  backLabel,
}: {
  card: DeckCard | null;
  onClose: () => void;
  onBack?: () => void;
  backLabel?: string;
}) {
  if (!card) return null;
  return (
    <div
      key={card.key}
      role="dialog"
      aria-label={card.title}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            title={backLabel ?? "Back"}
            aria-label={backLabel ?? "Back"}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          >
            <span aria-hidden className="text-sm leading-none">
              ‹
            </span>
          </button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          {card.title}
        </span>
        {card.badge ? (
          <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {card.badge}
          </span>
        ) : null}
        {card.actions}
        <button
          type="button"
          onClick={onClose}
          title={`Close ${card.title}`}
          aria-label={`Close ${card.title}`}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
        </button>
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          card.narrow ? "mx-auto w-full max-w-72 px-2.5 py-2" : "px-0 py-0",
        )}
      >
        {card.body}
      </div>
    </div>
  );
}
