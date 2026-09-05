import { describe, expect, it, vi } from "vitest";
import type {
  GhosttyTerminalModelApi,
  TerminalBufferSelection,
} from "../GhosttyTerminalModel";
import {
  normalizeSelection,
  selectionContains,
  shouldStartTerminalSelection,
  TerminalSelectionController,
} from "./TerminalSelectionController";

describe("selection across renderer replacement", () => {
  it("adopts native selection immediately and reconciles pruning without clearing the model", () => {
    let tracked: TerminalBufferSelection | null = {
      anchor: { line: 4, column: 1 },
      focus: { line: 4, column: 5 },
      rectangular: false,
    };
    const model = {
      trackedSelection: () => tracked,
      selectionText: vi.fn(() => "hello"),
      setSelection: vi.fn(),
    } as unknown as GhosttyTerminalModelApi;
    const target = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement;
    const create = () =>
      new TerminalSelectionController({
        model,
        target,
        cellSize: () => ({ width: 8, height: 16 }),
        shouldIgnoreTarget: () => false,
        onChange: vi.fn(),
      });
    const original = create();
    original.dispose();
    const replacement = create();
    expect(replacement.text()).toBe("hello");
    expect(replacement.contains(4, 3)).toBe(true);
    tracked = null;
    expect(replacement.reconcile()).toBe(true);
    expect(replacement.text()).toBeNull();
    tracked = {
      anchor: { line: 0, column: 0 },
      focus: { line: 0, column: 2 },
      rectangular: false,
    };
    expect(replacement.reconcile()).toBe(true);
    expect(replacement.value).toEqual(tracked);
    replacement.dispose();
    expect(model.setSelection).not.toHaveBeenCalled();
  });
});

describe("terminal selection pointer ownership", () => {
  it("does not capture a pointer already claimed by a resize separator", () => {
    expect(
      shouldStartTerminalSelection(
        {
          button: 0,
          defaultPrevented: true,
          shiftKey: false,
          target: null,
        },
        () => false,
        false,
      ),
    ).toBe(false);
  });

  it("keeps Shift selection available when an application tracks the mouse", () => {
    expect(
      shouldStartTerminalSelection(
        {
          button: 0,
          defaultPrevented: false,
          shiftKey: true,
          target: null,
        },
        () => false,
        true,
      ),
    ).toBe(true);
  });
});

describe("terminal selection geometry", () => {
  it("normalizes backward selections", () => {
    expect(
      normalizeSelection({
        anchor: { line: 8, column: 2 },
        focus: { line: 3, column: 7 },
        rectangular: false,
      }),
    ).toEqual({
      start: { line: 3, column: 7 },
      end: { line: 8, column: 2 },
      left: 2,
      right: 7,
    });
  });

  it("matches linear selections across row boundaries", () => {
    const selection: TerminalBufferSelection = {
      anchor: { line: 3, column: 7 },
      focus: { line: 5, column: 2 },
      rectangular: false,
    };
    expect(selectionContains(selection, { line: 3, column: 6 })).toBe(false);
    expect(selectionContains(selection, { line: 3, column: 7 })).toBe(true);
    expect(selectionContains(selection, { line: 4, column: 0 })).toBe(true);
    expect(selectionContains(selection, { line: 5, column: 2 })).toBe(true);
    expect(selectionContains(selection, { line: 5, column: 3 })).toBe(false);
  });

  it("matches rectangular selections in either drag direction", () => {
    const selection: TerminalBufferSelection = {
      anchor: { line: 5, column: 8 },
      focus: { line: 2, column: 3 },
      rectangular: true,
    };
    expect(selectionContains(selection, { line: 2, column: 3 })).toBe(true);
    expect(selectionContains(selection, { line: 4, column: 6 })).toBe(true);
    expect(selectionContains(selection, { line: 5, column: 9 })).toBe(false);
    expect(selectionContains(selection, { line: 1, column: 6 })).toBe(false);
  });
});
