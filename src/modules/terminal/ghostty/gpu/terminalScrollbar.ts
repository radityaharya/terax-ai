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
  const visibility = available ? "visible" : "hidden";
  if (scrollbar.style.visibility !== visibility)
    scrollbar.style.visibility = visibility;
  setAttribute(scrollbar, "aria-valuemin", "0");
  setAttribute(scrollbar, "aria-valuemax", String(history));
  setAttribute(scrollbar, "aria-valuenow", String(history - offset));
  if (!available) return null;

  const height = `${host.clientHeight + history * cellHeight}px`;
  if (content.style.height !== height) content.style.height = height;
  const target = (history - offset) * cellHeight;
  if (Math.round(scrollbar.scrollTop / cellHeight) !== history - offset) {
    scrollbar.scrollTop = target;
  }
  return scrollbar.scrollTop;
}

function setAttribute(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
