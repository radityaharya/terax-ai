import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage: (value: unknown) => void }>,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_value: unknown) => {};

    constructor() {
      mocks.channels.push(this);
    }
  },
  invoke: mocks.invoke,
}));

vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => null,
}));

import { openPty } from "./pty-bridge";

describe("PTY output flow control", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.channels.length = 0;
    mocks.invoke.mockReset();
  });

  it("acknowledges output that arrives before pty_open resolves", async () => {
    let resolveOpen: ((id: number) => void) | undefined;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "pty_open") {
        return new Promise<number>((resolve) => {
          resolveOpen = resolve;
        });
      }
      return Promise.resolve();
    });
    const onData = vi.fn();
    const opening = openPty(80, 24, { onData });
    const bytes = new Uint8Array([1, 2, 3]);

    mocks.channels[0].onmessage(bytes.buffer);
    await Promise.resolve();
    expect(onData).toHaveBeenCalledWith(bytes);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "pty_ack_output",
      expect.anything(),
    );

    resolveOpen?.(41);
    await opening;

    expect(mocks.invoke).toHaveBeenCalledWith("pty_ack_output", {
      id: 41,
      bytes: 3,
    });
  });

  it("waits for asynchronous parser completion before returning credit", async () => {
    mocks.invoke.mockImplementation((command: string) =>
      command === "pty_open" ? Promise.resolve(7) : Promise.resolve(),
    );
    let finishDelivery: (() => void) | undefined;
    const session = await openPty(80, 24, {
      onData: () =>
        new Promise<void>((resolve) => {
          finishDelivery = resolve;
        }),
    });
    const bytes = new Uint8Array([4, 5]);

    mocks.channels[0].onmessage(bytes.buffer);
    await Promise.resolve();
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "pty_ack_output",
      expect.anything(),
    );

    finishDelivery?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.invoke).toHaveBeenCalledWith("pty_ack_output", {
      id: session.id,
      bytes: 2,
    });
  });
});
