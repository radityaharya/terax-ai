import { useCallback, useEffect, useRef } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useSidebarDeckStore } from "./sidebarDeckStore";

export const SIDEBAR_DECK_DEFAULT_WIDTH = 340;
export const SIDEBAR_DECK_MIN_WIDTH = 260;
export const SIDEBAR_DECK_MAX_WIDTH = 640;
const SIDEBAR_DECK_WIDTH_STORAGE_KEY = "terax.sidebarDeck.width";

function clampDeckWidth(width: number): number {
  return Math.min(
    SIDEBAR_DECK_MAX_WIDTH,
    Math.max(SIDEBAR_DECK_MIN_WIDTH, Math.round(width)),
  );
}

function readDeckWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_DECK_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
    return Number.isFinite(parsed)
      ? clampDeckWidth(parsed)
      : SIDEBAR_DECK_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DECK_DEFAULT_WIDTH;
  }
}

/** Drives the deck as a real third ResizablePanel next to the sidebar: it
 *  mounts/collapses based on `useSidebarDeckStore`'s card, and its width
 *  persists independently of the sidebar's own width. Opening a card
 *  expands the panel from 0; closing it (or clearing the card) collapses
 *  back to 0 instead of unmounting — width restores on next open. */
export function useSidebarDeckPanel() {
  const deckRef = useRef<PanelImperativeHandle | null>(null);
  const deckWidthRef = useRef(readDeckWidth());
  const deckWidthWriteTimerRef = useRef(0);
  const card = useSidebarDeckStore((s) => s.card);
  const closeCard = useSidebarDeckStore((s) => s.closeCard);

  const persistDeckWidth = useCallback(
    (next: number, isUserInteraction: boolean) => {
      if (!isUserInteraction || next <= 0) return;
      deckWidthRef.current = clampDeckWidth(next);
      if (deckWidthWriteTimerRef.current) {
        window.clearTimeout(deckWidthWriteTimerRef.current);
      }
      deckWidthWriteTimerRef.current = window.setTimeout(() => {
        deckWidthWriteTimerRef.current = 0;
        try {
          window.localStorage.setItem(
            SIDEBAR_DECK_WIDTH_STORAGE_KEY,
            String(deckWidthRef.current),
          );
        } catch {
          // ignore
        }
      }, 200);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (deckWidthWriteTimerRef.current) {
        window.clearTimeout(deckWidthWriteTimerRef.current);
      }
    };
  }, []);

  // Expand/collapse the real panel to track the store's card, so the
  // list pane always resizes properly instead of being covered.
  useEffect(() => {
    const panel = deckRef.current;
    if (!panel) return;
    const collapsed = panel.getSize().asPercentage <= 0;
    if (card && collapsed) {
      panel.resize(`${deckWidthRef.current}px`);
    } else if (!card && !collapsed) {
      panel.collapse();
    }
  }, [card]);

  const closeDeck = useCallback(() => {
    closeCard();
    deckRef.current?.collapse();
  }, [closeCard]);

  return {
    deckRef,
    deckWidthRef,
    card,
    closeDeck,
    persistDeckWidth,
  };
}
