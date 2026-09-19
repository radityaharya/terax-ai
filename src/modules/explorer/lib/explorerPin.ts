import { create } from "zustand";

export type ExplorerPin = {
  /** Pinned directory. Null = follow the active terminal (default). */
  root: string | null;
  /** Host the pin belongs to (null = local). Pin auto-clears on host change. */
  hostId: string | null;
};

type State = {
  pin: ExplorerPin;
  /** Pin the explorer to `root` on `hostId` (null = local). */
  setPin: (root: string, hostId: string | null) => void;
  clearPin: () => void;
  togglePin: (root: string, hostId: string | null) => void;
  /**
   * Per-scope memory: scope key ("local" | "wsl:<d>" | "ssh:<host>") ->
   * last directory the explorer showed for that scope. Updated only by
   * focused-pane cd / explicit reveal, never by tab switches.
   */
  memory: Record<string, string>;
  remember: (scopeKey: string, root: string) => void;
};

export const useExplorerPinStore = create<State>((set, get) => ({
  pin: { root: null, hostId: null },
  setPin: (root, hostId) => set({ pin: { root, hostId } }),
  clearPin: () => set({ pin: { root: null, hostId: null } }),
  togglePin: (root, hostId) => {
    const { pin } = get();
    if (pin.root === root && pin.hostId === hostId) {
      set({ pin: { root: null, hostId: null } });
    } else {
      set({ pin: { root, hostId } });
    }
  },
  memory: {},
  remember: (scopeKey, root) =>
    set((s) =>
      s.memory[scopeKey] === root
        ? s
        : { memory: { ...s.memory, [scopeKey]: root } },
    ),
}));

/**
 * Effective pin for the current context: returns the pin only when it
 * belongs to the active host (a pin on host A must not freeze the explorer
 * after jumping to host B). Callers pass the active tab's host id.
 */
export function activePin(
  pin: ExplorerPin,
  activeHostId: string | null,
): string | null {
  if (!pin.root) return null;
  if (pin.hostId !== activeHostId) return null;
  return pin.root;
}

/** Last remembered root for a scope, if any. */
export function scopeMemoryRoot(
  memory: Record<string, string>,
  scopeKey: string,
): string | null {
  return memory[scopeKey] ?? null;
}
