import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockDecorations } from "./blockDecorations";

type OscHandler = (data: string) => boolean | Promise<boolean>;

// BlockDecorations schedules viewport updates via rAF; the headless test env
// has none, and we don't assert on viewport geometry, so a no-op is enough.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// Minimal headless fake of the xterm surface BlockDecorations touches. Markers
// report whatever line was last set, so a test can place C/D at chosen rows.
function makeFakeTerm() {
  const handlers = new Map<number, OscHandler>();
  let currentLine = 0;
  const term = {
    options: {} as Record<string, unknown>,
    element: null,
    parser: {
      registerOscHandler(code: number, h: OscHandler) {
        handlers.set(code, h);
        return { dispose: () => handlers.delete(code) };
      },
    },
    registerMarker: vi.fn(() => ({
      line: currentLine,
      isDisposed: false,
      dispose: vi.fn(),
    })),
    registerDecoration: vi.fn(() => ({ dispose: vi.fn(), onRender: vi.fn() })),
    onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    onRender: vi.fn(() => ({ dispose: vi.fn() })),
    buffer: {
      active: {
        type: "normal",
        length: 5000,
        baseY: 0,
        cursorY: 0,
        viewportY: 0,
        getLine: () => ({ translateToString: () => "" }),
      },
    },
  } as unknown as Terminal;
  return {
    term,
    emit: (payload: string) => handlers.get(133)?.(payload),
    setLine: (n: number) => {
      currentLine = n;
    },
  };
}

describe("BlockDecorations — OSC 133 block lifecycle", () => {
  it("creates a finished block on C..D with command, exit code and range", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    setLine(5);
    emit("C;ls -al");
    setLine(9);
    emit("D;0");
    const blocks = deco.getBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("ls -al");
    expect(blocks[0].exitCode).toBe(0);
    expect(blocks[0].startLine).toBe(5);
    expect(blocks[0].endLine).toBe(9);
  });

  it("records a non-zero exit code", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    setLine(2);
    emit("C;false");
    emit("D;1");
    expect(deco.getBlocks()[0].exitCode).toBe(1);
  });

  it("keeps no finished block while a command is still running", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    setLine(1);
    emit("C;sleep 10");
    expect(deco.getBlocks()).toHaveLength(0);
  });

  it("auto-closes a live block when a new C arrives without a D", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    setLine(1);
    emit("C;first");
    setLine(3);
    emit("C;second");
    const blocks = deco.getBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("first");
    expect(blocks[0].exitCode).toBeNull();
  });

  it("ignores a D that arrives with no live block", () => {
    const { term, emit } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    emit("D;0");
    expect(deco.getBlocks()).toHaveLength(0);
  });

  it("caps history at MAX_BLOCKS, dropping the oldest", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    for (let i = 0; i < 1005; i++) {
      setLine(i);
      emit(`C;cmd${i}`);
      emit("D;0");
    }
    const blocks = deco.getBlocks();
    expect(blocks).toHaveLength(1000);
    expect(blocks[0].command).toBe("cmd5");
    expect(blocks[blocks.length - 1].command).toBe("cmd1004");
  });
});
