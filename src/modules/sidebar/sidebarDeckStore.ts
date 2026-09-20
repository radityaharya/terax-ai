import { create } from "zustand";
import type { DeckCard } from "./SidebarDeck";

type SidebarDeckState = {
  /** Single focused detail card, shared across every sidebar view (Docker
   *  inspect/logs/exec, and future git/host detail surfaces). Opening a
   *  card always replaces whatever is open — the deck never stacks. */
  card: DeckCard | null;
  openCard: (card: DeckCard) => void;
  closeCard: () => void;
};

export const useSidebarDeckStore = create<SidebarDeckState>((set) => ({
  card: null,
  openCard: (card) => set({ card }),
  closeCard: () => set({ card: null }),
}));
