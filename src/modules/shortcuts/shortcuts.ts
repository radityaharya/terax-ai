import { IS_MAC } from "@/lib/platform";

export const DEFAULT_MODIFIER: keyof KeyBinding = IS_MAC ? "meta" : "ctrl";

/**
 * Single source of truth for keyboard shortcuts.
 */

export type ShortcutId =
  | "tab.new"
  | "tab.newPreview"
  | "tab.newEditor"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | "tab.selectByIndex"
  | "search.focus"
  | "ai.toggle"
  | "ai.askSelection"
  | "shortcuts.open"
  | "settings.open"
  | "sidebar.toggle";

export type ShortcutGroup = "General" | "Tabs" | "Search" | "AI" | "View";

export type KeyBinding = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type Shortcut = {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  defaultBindings: KeyBinding[];
};

export const SHORTCUTS: Shortcut[] = [
  {
    id: "settings.open",
    label: "Open settings",
    group: "General",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "," }],
  },
  {
    id: "shortcuts.open",
    label: "Show keyboard shortcuts",
    group: "General",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "k" }],
  },
  {
    id: "tab.new",
    label: "New tab",
    group: "Tabs",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "t" }],
  },
  {
    id: "tab.newPreview",
    label: "New preview tab",
    group: "Tabs",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "p" }],
  },
  {
    id: "tab.newEditor",
    label: "New editor tab",
    group: "Tabs",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "e" }],
  },
  {
    id: "tab.close",
    label: "Close tab",
    group: "Tabs",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "w" }],
  },
  {
    id: "tab.next",
    label: "Next tab",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, key: "Tab" }],
  },
  {
    id: "tab.prev",
    label: "Previous tab",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, shift: true, key: "Tab" }],
  },
  {
    id: "tab.selectByIndex",
    label: "Jump to tab 1–9",
    group: "Tabs",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "1" }],
  },
  {
    id: "search.focus",
    label: "Find in terminal",
    group: "Search",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "f" }],
  },
  {
    id: "ai.toggle",
    label: "Toggle AI agent",
    group: "AI",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "i" }],
  },
  {
    id: "ai.askSelection",
    label: "Ask AI about selection",
    group: "AI",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "l" }],
  },
  {
    id: "sidebar.toggle",
    label: "Toggle file explorer",
    group: "View",
    defaultBindings: [{ [DEFAULT_MODIFIER]: true, key: "b" }],
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "General",
  "Tabs",
  "View",
  "Search",
  "AI",
];

/**
 * Matching logic: checks if a KeyboardEvent matches a KeyBinding.
 */
export function matchBinding(e: KeyboardEvent, binding: KeyBinding, id?: ShortcutId): boolean {
  const eventKey = e.key.toLowerCase();
  const bindingKey = binding.key.toLowerCase();

  // Special case for Jump to Tab 1-9
  if (id === "tab.selectByIndex") {
    if (!/^[1-9]$/.test(e.key)) return false;
  } else if (eventKey !== bindingKey) {
    return false;
  }

  return (
    !!e.ctrlKey === !!binding.ctrl &&
    !!e.shiftKey === !!binding.shift &&
    !!e.altKey === !!binding.alt &&
    !!e.metaKey === !!binding.meta
  );
}

/**
 * Display helpers
 */
export function getBindingTokens(binding?: KeyBinding): string[] {
  if (!binding) return [];
  const tokens: string[] = [];
  if (IS_MAC) {
    if (binding.ctrl) tokens.push("⌃");
    if (binding.alt) tokens.push("⌥");
    if (binding.shift) tokens.push("⇧");
    if (binding.meta) tokens.push("⌘");
  } else {
    if (binding.ctrl) tokens.push("Ctrl");
    if (binding.alt) tokens.push("Alt");
    if (binding.shift) tokens.push("Shift");
    if (binding.meta) tokens.push("Win");
  }

  let keyLabel = binding.key;
  if (keyLabel === " ") keyLabel = "Space";
  else if (keyLabel === "ArrowUp") keyLabel = "↑";
  else if (keyLabel === "ArrowDown") keyLabel = "↓";
  else if (keyLabel === "ArrowLeft") keyLabel = "←";
  else if (keyLabel === "ArrowRight") keyLabel = "→";
  else if (keyLabel.length === 1) keyLabel = keyLabel.toUpperCase();

  tokens.push(keyLabel);
  return tokens;
}
