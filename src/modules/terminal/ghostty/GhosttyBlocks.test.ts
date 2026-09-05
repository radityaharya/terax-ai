import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { TeraxGhostty } from "@terax/ghostty-core/adapted";
import { AdaptedGhosttyTerminalModel } from "@/modules/terminal/ghostty/AdaptedGhosttyTerminalModel";
import {
  GhosttyBlocks,
  matchCellText,
} from "@/modules/terminal/ghostty/GhosttyBlocks";

describe("Ghostty command blocks", () => {
  let core: TeraxGhostty;
  beforeAll(async () => {
    const bytes = await readFile(
      new URL(
        "../../../../packages/ghostty-core/adapted/ghostty-vt.wasm",
        import.meta.url,
      ),
    );
    core = await TeraxGhostty.loadBytes(Uint8Array.from(bytes).buffer);
  });

  function create() {
    let blocks: GhosttyBlocks;
    const model = new AdaptedGhosttyTerminalModel(core, {
      backend: "ghostty-webgpu",
      cols: 20,
      rows: 6,
      onEvent: (event) => blocks.handle(event, "/workspace"),
    });
    blocks = new GhosttyBlocks(model);
    return {
      model,
      blocks,
      write: (text: string) => model.write(new TextEncoder().encode(text)),
      dispose: () => {
        blocks.dispose();
        model.dispose();
      },
    };
  }

  it("retains commands, status and output for multiple commands in one parse", () => {
    const { model, blocks, write, dispose } = create();
    try {
      write(
        "\x1b]133;C;first\x07one\r\n\x1b]133;D;1000\x07\x1b]133;C;second\x07two\r\n\x1b]133;D;0\x07",
      );
      expect(blocks.mode).toBe("prompt");
      expect(blocks.readById("1")).toEqual({
        command: "first",
        cwd: "/workspace",
        exitCode: 1000,
        output: "one",
      });
      expect(blocks.readById("2")?.output).toBe("two");
      expect(blocks.visibleBlocks(20).blocks).toHaveLength(2);
      expect(blocks.navigate(-1)).toBe(true);
      expect(model.trackedSelection()).not.toBeNull();
      expect(blocks.clearSelection()).toBe(true);
    } finally {
      dispose();
    }
  });

  it("keeps direct input until shell integration confirms a shared prompt", () => {
    const { blocks, write, dispose } = create();
    try {
      expect(blocks.mode).toBe("plain");
      write("bare shell> \x1b]133;A\x07");
      expect(blocks.mode).toBe("plain");
      write("\x1b]133;B;terax_blocks=0\x07");
      expect(blocks.mode).toBe("plain");
      write("\x1b]133;C;command\x07\x1b]133;D;0\x07");
      expect(blocks.mode).toBe("plain");
      write("\x1b]133;B\x07");
      expect(blocks.mode).toBe("prompt");
    } finally {
      dispose();
    }
  });

  it("keeps selections and viewport intact while reading and searching blocks", () => {
    const { model, blocks, write, dispose } = create();
    try {
      write(
        "\x1b]133;C;echo\x07wide 日本語 output\r\nsecond\r\n\x1b]133;D;0\x07",
      );
      model.setSelection({
        anchor: { line: 1, column: 0 },
        focus: { line: 1, column: 5 },
        rectangular: false,
      });
      const selection = model.trackedSelection();
      const origin = model.viewportOriginLine();
      expect(blocks.readById("1")?.output).toContain("日本語");
      const matches = blocks.searchBlock("1", "日本語");
      expect(matches[0]).toEqual({ line: 0, col: 5, len: 6 });
      expect(model.trackedSelection()).toEqual(selection);
      expect(model.viewportOriginLine()).toBe(origin);
      blocks.revealMatch(matches[0]);
      expect(model.searchViewportMatches()).toContainEqual({
        row: 0,
        startColumn: 5,
        endColumn: 11,
        selected: true,
      });
      blocks.clearSearch();
      expect(model.searchViewportMatches()).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("hides block chrome in alternate screen and preserves it on return", () => {
    const { blocks, write, dispose } = create();
    try {
      blocks.submitted("vim");
      write("\x1b]133;C\x07\x1b[?1049hTUI");
      expect(blocks.mode).toBe("alt");
      expect(blocks.visibleBlocks(20).blocks).toHaveLength(0);
      write("\x1b[?1049l\x1b]133;D;0\x07");
      expect(blocks.mode).toBe("prompt");
      expect(blocks.readById("1")?.command).toBe("vim");
    } finally {
      dispose();
    }
  });

  it("selects and searches exact inline command boundaries", () => {
    const { model, blocks, write, dispose } = create();
    try {
      write("prompt \x1b]133;C;echo\x07output\x1b]133;D;0\x07 next");
      expect(blocks.selectAtLine(0)).toBe(true);
      const selection = model.trackedSelection();
      expect(selection).toEqual({
        anchor: { line: 0, column: 7 },
        focus: { line: 0, column: 12 },
        rectangular: false,
      });
      if (!selection) throw new Error("Missing command selection");
      expect(model.selectionText(selection)).toBe("output");
      expect(blocks.searchBlock("1", "next")).toEqual([]);
      blocks.revealMatch({ line: 0, col: 7, len: 6 });
      model.resize(10, 6);
      expect(model.blockSearchActive()).toBe(false);
      expect(blocks.readById("1")?.output).toBe("output");
    } finally {
      dispose();
    }
  });

  it("bounds overview marks and gives failures precedence at the same location", () => {
    const { blocks, write, dispose } = create();
    try {
      write(
        "\x1b]133;C;bad\x07\x1b]133;D;1\x07\x1b]133;C;ok\x07\x1b]133;D;0\x07",
      );
      expect(blocks.overviewRows()).toHaveLength(256);
      expect(blocks.overviewRows()[0]).toBe(2);
      expect(blocks.selectAtLine(0)).toBe(false);
      write("\x1bc");
      expect(blocks.overviewRows().some(Boolean)).toBe(false);
    } finally {
      dispose();
    }
  });

  it("clears stale block identities after a terminal reset", () => {
    const { blocks, write, dispose } = create();
    try {
      write("\x1b]133;C;old\x07output\r\n\x1b]133;D;0\x07\x1bc");
      expect(blocks.readById("1")).toBeNull();
      expect(blocks.visibleBlocks(20).blocks).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("bounds retained command metadata by bytes as well as block count", () => {
    const { blocks, write, dispose } = create();
    try {
      const command = "x".repeat(8192);
      for (let index = 0; index < 100; index++) {
        blocks.submitted(command);
        write("\x1b]133;C\x07\x1b]133;D;0\x07");
      }
      expect(blocks.diagnostics().metadataBytes).toBeLessThanOrEqual(
        512 * 1024,
      );
      expect(blocks.diagnostics().blocks).toBeLessThan(100);
      expect(blocks.readById("1")).toBeNull();
      expect(blocks.readById("100")?.command).toBe(command);
    } finally {
      dispose();
    }
  });

  it("retains the submitted command and never reruns a truncated label", () => {
    const { blocks, write, dispose } = create();
    try {
      const command = "echo ".repeat(100);
      blocks.submitted(command);
      write(`\x1b]133;C;${command.slice(0, 256)}\x07\x1b]133;D;0\x07`);
      expect(blocks.readById("1")?.command).toBe(command);
      expect(blocks.visibleBlocks(20).blocks[0].canRerun).toBe(true);
      blocks.submitted("x".repeat(8193));
      write("\x1b]133;C;label\x07\x1b]133;D;0\x07");
      expect(blocks.visibleBlocks(20).blocks[1].canRerun).toBe(false);
    } finally {
      dispose();
    }
  });
});

it("maps Unicode search offsets to terminal cells", () => {
  expect(
    matchCellText(["a", "日", "", "e\u0301", " ", "İ", "z"], "E\u0301"),
  ).toEqual([{ col: 3, len: 1 }]);
  expect(matchCellText(["İ", "z"], "Z")).toEqual([{ col: 1, len: 1 }]);
});
