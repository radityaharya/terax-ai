import { terminalFrameIntervalMs } from "@/modules/terminal/ghostty/renderScheduling";

type Surface = { isFocused(): boolean };
const FRAME_LEAD_MS = 1_000 / 60;

export class SurfaceFramePacer {
  private presentedAt = new WeakMap<Surface, number>();

  delay(
    surfaces: ReadonlySet<Surface>,
    windowFocused: boolean,
    now: number,
  ): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const surface of surfaces) {
      earliest = Math.min(earliest, this.deadline(surface, windowFocused));
    }
    return Math.max(0, earliest - now - FRAME_LEAD_MS);
  }

  due(surface: Surface, windowFocused: boolean, now: number): boolean {
    return now + 0.1 >= this.deadline(surface, windowFocused);
  }

  presented(surface: Surface, now: number): void {
    this.presentedAt.set(surface, now);
  }

  reset(): void {
    this.presentedAt = new WeakMap();
  }

  private deadline(surface: Surface, windowFocused: boolean): number {
    const last = this.presentedAt.get(surface);
    return last === undefined
      ? Number.NEGATIVE_INFINITY
      : last + terminalFrameIntervalMs(windowFocused, surface.isFocused());
  }
}
