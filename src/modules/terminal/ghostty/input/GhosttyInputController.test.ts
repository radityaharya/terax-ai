import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import { describe, expect, it, vi } from "vitest";
import {
  GhosttyInputController,
  terminalMouseModifiers,
} from "./GhosttyInputController";

describe("terminalMouseModifiers", () => {
  it("encodes xterm Shift, Alt, and Control bits", () => {
    expect(
      terminalMouseModifiers({ shiftKey: true, altKey: true, ctrlKey: true }),
    ).toBe(28);
  });

  it("does not confuse the macOS Command modifier with Alt", () => {
    const commandOnly = {
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: true,
    };
    expect(terminalMouseModifiers(commandOnly)).toBe(0);
  });
});

describe("GhosttyInputController", () => {
  it("routes prompt paste to the command editor without also sending PTY bytes", () => {
    const model = inputModel();
    const onData = vi.fn();
    const onPaste = vi.fn(() => true);
    const controller = new GhosttyInputController({
      model,
      input: new FakeTextArea() as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      isMac: true,
      onCopy: () => false,
      onData,
      onPaste,
    });
    controller.paste("echo text");
    expect(onPaste).toHaveBeenCalledWith("echo text");
    expect(onData).not.toHaveBeenCalled();
    onPaste.mockReturnValue(false);
    controller.paste("process input");
    expect(new TextDecoder().decode(onData.mock.calls[0][0])).toBe(
      "process input",
    );
    controller.dispose();
  });

  it("routes keys and composed text back to the prompt after a native menu", () => {
    const input = new FakeTextArea();
    const onKeyDown = vi.fn(() => true);
    const onText = vi.fn(() => true);
    const onData = vi.fn();
    const controller = new GhosttyInputController({
      model: inputModel(),
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      isMac: true,
      onCopy: () => false,
      onKeyDown,
      onText,
      onData,
    });
    const interrupt = keyboardEvent({ key: "c", code: "KeyC", ctrlKey: true });
    input.dispatchEvent(interrupt);
    expect(onKeyDown).toHaveBeenCalledWith(interrupt);
    expect(interrupt.defaultPrevented).toBe(true);
    onKeyDown.mockReturnValue(false);
    input.dispatchEvent(keyboardEvent({ key: "x", code: "KeyX" }));
    expect(onText).toHaveBeenCalledWith("x");
    input.dispatchEvent(
      Object.assign(new Event("compositionend"), { data: "あ" }),
    );
    input.dispatchEvent(
      Object.assign(new Event("beforeinput", { cancelable: true }), {
        inputType: "insertText",
        data: "あ",
        isComposing: false,
      }),
    );
    expect(onText.mock.calls).toEqual([["x"], ["あ"]]);
    expect(onData).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("delivers Ctrl+C to the terminal and leaves unencoded shortcuts unconsumed", () => {
    const input = new FakeTextArea();
    const onData = vi.fn();
    const encodeKey = vi.fn(() => new Uint8Array([3]));
    const controller = new GhosttyInputController({
      model: { ...inputModel(), encodeKey },
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      isMac: true,
      onCopy: () => true,
      onData,
    });
    const interrupt = keyboardEvent({ key: "c", code: "KeyC", ctrlKey: true });
    input.dispatchEvent(interrupt);
    expect(interrupt.defaultPrevented).toBe(true);
    expect(onData).toHaveBeenCalledWith(new Uint8Array([3]));
    encodeKey.mockReturnValue(new Uint8Array(0));
    const shortcut = keyboardEvent({ key: "p", code: "KeyP", metaKey: true });
    input.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
    const handled = keyboardEvent({ key: "c", code: "KeyC", ctrlKey: true });
    handled.preventDefault();
    input.dispatchEvent(handled);
    expect(onData).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("commits IME text once and leaves dead-key composition to the webview", () => {
    const input = new FakeTextArea();
    const onData = vi.fn();
    const model = inputModel();
    const encodeKey = vi.fn(() => new Uint8Array(0));
    const controller = new GhosttyInputController({
      model: { ...model, encodeKey },
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      onData,
      onCopy: () => false,
      isMac: false,
    });
    input.dispatchEvent(keyboardEvent({ key: "Dead", code: "Quote" }));
    expect(encodeKey).not.toHaveBeenCalled();
    input.dispatchEvent(new Event("compositionstart"));
    input.dispatchEvent(
      keyboardEvent({ key: "a", code: "KeyA", isComposing: true }),
    );
    input.dispatchEvent(
      Object.assign(new Event("beforeinput"), {
        inputType: "insertCompositionText",
        data: "あ",
        isComposing: true,
      }),
    );
    expect(onData).not.toHaveBeenCalled();
    input.dispatchEvent(
      Object.assign(new Event("compositionend"), { data: "あ" }),
    );
    input.dispatchEvent(
      Object.assign(new Event("beforeinput", { cancelable: true }), {
        inputType: "insertText",
        data: "あ",
        isComposing: false,
      }),
    );
    expect(onData).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(onData.mock.calls[0][0])).toBe("あ");
    controller.dispose();
  });

  it("encodes AltGr characters and keeps a duplicate beforeinput from typing twice", () => {
    const input = new FakeTextArea();
    const onData = vi.fn();
    const controller = new GhosttyInputController({
      model: inputModel(),
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      onData,
      onCopy: () => false,
      isMac: false,
    });
    input.dispatchEvent(
      keyboardEvent({
        key: "@",
        code: "KeyQ",
        altKey: true,
        ctrlKey: true,
        getModifierState: (key) => key === "AltGraph",
      }),
    );
    input.dispatchEvent(
      Object.assign(new Event("beforeinput", { cancelable: true }), {
        inputType: "insertText",
        data: "@",
        isComposing: false,
      }),
    );
    expect(onData).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(onData.mock.calls[0][0])).toBe("@");
    controller.dispose();
  });

  it("does not deliver a late clipboard result after the input owner is disposed", () => {
    const model = inputModel();
    const modes = vi.fn(model.modes);
    const onData = vi.fn();
    const input = new FakeTextArea();
    const controller = new GhosttyInputController({
      model: { ...model, modes },
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      onData,
      onCopy: () => false,
      isMac: false,
    });
    controller.dispose();
    controller.paste("late clipboard");
    input.dispatchEvent(keyboardEvent({ key: "x", code: "KeyX" }));
    expect(onData).not.toHaveBeenCalled();
    expect(modes).not.toHaveBeenCalled();
  });
  it("emits macOS Option-produced Unicode as text by default", () => {
    const input = new FakeTextArea();
    const pointerTarget = new FakeElement();
    const onData = vi.fn();
    const controller = new GhosttyInputController({
      model: inputModel(),
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: pointerTarget as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      onData,
      onCopy: () => false,
      isMac: true,
    });

    input.dispatchEvent(
      keyboardEvent({
        key: "å",
        code: "KeyA",
        altKey: true,
      }),
    );

    expect(new TextDecoder().decode(onData.mock.calls[0][0])).toBe("å");
    controller.dispose();
  });

  it("deduplicates identical mouse-motion reports within a cell", () => {
    const input = new FakeTextArea();
    const pointerTarget = new FakeElement();
    const onData = vi.fn();
    const controller = new GhosttyInputController({
      model: inputModel((mode) => mode === 1003 || mode === 1006),
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: pointerTarget as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      onData,
      onCopy: () => false,
      isMac: false,
    });

    for (let index = 0; index < 2; index += 1) {
      pointerTarget.dispatchEvent(
        mouseEvent("mousemove", {
          clientX: 15,
          clientY: 25,
        }),
      );
    }

    expect(onData).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(onData.mock.calls[0][0])).toBe(
      "\x1b[<32;2;2M",
    );
    controller.dispose();
  });
});

function inputModel(
  mode: (value: number) => boolean = () => false,
): GhosttyTerminalModelApi {
  return {
    cols: 80,
    rows: 24,
    modes: () => ({
      alternateScreen: false,
      bracketedPaste: false,
      focusReporting: false,
      mouseTracking: true,
      synchronizedOutput: false,
    }),
    mode,
    scrollToBottom: () => false,
    scrollPosition: () => ({ offset: 0, history: 0 }),
    scrollBy: () => false,
    encodeKey: () => new Uint8Array(0),
  } as unknown as GhosttyTerminalModelApi;
}

class FakeElement extends EventTarget {
  getBoundingClientRect(): DOMRect {
    return {
      left: 0,
      top: 0,
      right: 800,
      bottom: 480,
      width: 800,
      height: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

class FakeTextArea extends FakeElement {
  value = "";
}

function keyboardEvent(values: Partial<KeyboardEvent>): KeyboardEvent {
  return Object.assign(
    new Event("keydown", { bubbles: true, cancelable: true }),
    {
      altKey: false,
      code: "",
      ctrlKey: false,
      getModifierState: () => false,
      isComposing: false,
      key: "",
      keyCode: 0,
      metaKey: false,
      repeat: false,
      shiftKey: false,
      ...values,
    },
  ) as KeyboardEvent;
}

function mouseEvent(type: string, values: Partial<MouseEvent>): MouseEvent {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    altKey: false,
    button: 0,
    clientX: 0,
    clientY: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...values,
  }) as MouseEvent;
}
