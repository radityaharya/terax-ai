import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";

export function syncTerminalScrollbar(
  host: HTMLElement,
  scrollbar: HTMLElement,
  content: HTMLElement,
  model: GhosttyTerminalModelApi,
  cellHeight: number,
): number | null {
  const { history, offset } = model.scrollPosition();
  const available = history > 0 && !model.modes().alternateScreen;
  scrollbar.style.visibility = available ? "visible" : "hidden";
  scrollbar.setAttribute("aria-valuemin", "0");
  scrollbar.setAttribute("aria-valuemax", String(history));
  scrollbar.setAttribute("aria-valuenow", String(history - offset));
  if (!available) return null;

  content.style.height = `${host.clientHeight + history * cellHeight}px`;
  const target = (history - offset) * cellHeight;
  if (Math.round(scrollbar.scrollTop / cellHeight) !== history - offset) {
    scrollbar.scrollTop = target;
  }
  return scrollbar.scrollTop;
}
