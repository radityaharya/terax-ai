import {
  clearAgentActivity,
  ensureAgentActivityListener,
} from "@/modules/terminal/lib/agentActivity";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { Channel, invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  PtyOutputReceiver,
  type PtyOutputStatus,
} from "@/modules/terminal/lib/PtyOutputReceiver";

const textEncoder = new TextEncoder();
const receivers = new Map<number, PtyOutputReceiver>();

export function ptyTransportDiagnostics() {
  return [...receivers].map(([id, receiver]) => ({
    id,
    ...receiver.diagnostics(),
  }));
}

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void | Promise<void>;
  onExit?: (code: number) => void;
  onOutputStatus?: (status: PtyOutputStatus) => void;
};

export type PtySession = {
  id: number;
  write: (data: string | Uint8Array) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

export type OpenPtyOptions = {
  cwd?: string;
  blocks?: boolean;
  shell?: string;
  paneId?: number;
  /**
   * Execution env for the spawned shell. Defaults to the global workspace
   * env (the active tab's env, mirrored by App). Pass the owning tab's env
   * explicitly so background tabs spawn on their own host.
   */
  env?: WorkspaceEnv;
};

/**
 * Positional args kept for tests: openPty(cols, rows, handlers, cwd?, blocks?,
 * shell?, paneId?, env?). New call sites should prefer the options object.
 */
export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  blocks?: boolean,
  shell?: string,
  paneId?: number,
  env?: WorkspaceEnv,
): Promise<PtySession>;
export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  options?: OpenPtyOptions,
): Promise<PtySession>;
export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwdOrOptions?: string | OpenPtyOptions,
  blocksArg?: boolean,
  shellArg?: string,
  paneIdArg?: number,
  envArg?: WorkspaceEnv,
): Promise<PtySession> {
  const opts: OpenPtyOptions =
    typeof cwdOrOptions === "object" && cwdOrOptions !== null
      ? cwdOrOptions
      : {
          cwd: cwdOrOptions,
          blocks: blocksArg,
          shell: shellArg,
          paneId: paneIdArg,
          env: envArg,
        };
  // Raw bytes preserve split UTF-8 and escape sequences across IPC.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();

  let id: number | null = null;
  let released = false;
  let notice: string | number | undefined;
  const receiver = new PtyOutputReceiver(
    handlers.onData,
    (bytes) => invoke("pty_ack_output", { id, bytes }),
    (status) => {
      handlers.onOutputStatus?.(status);
      if (status === "running") {
        if (notice !== undefined) toast.dismiss(notice);
        notice = undefined;
      } else if (status === "stalled" || status === "failed") {
        notice = toast.error("Terminal output paused", {
          id: notice,
          duration: Number.POSITIVE_INFINITY,
          description:
            status === "failed"
              ? "The terminal could not process output. Reopen this terminal to recover."
              : "Waiting for the terminal connection. Delivery will resume automatically.",
          action:
            status === "failed"
              ? undefined
              : {
                  label: "Retry",
                  onClick: () => receiver.retry(),
                },
        });
      }
    },
  );
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    receiver.dispose();
    if (id !== null) {
      receivers.delete(id);
      clearAgentActivity(id);
    }
    if (notice !== undefined) toast.dismiss(notice);
    onData.onmessage = () => {};
    onExit.onmessage = () => {};
  };

  onData.onmessage = (buf) => receiver.receive(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    try {
      handlers.onExit?.(code);
    } finally {
      releaseHandlers();
    }
  };

  const { cwd, blocks, shell, paneId, env: spawnEnv } = opts;
  try {
    await ensureAgentActivityListener();
    id = await invoke<number>("pty_open", {
      cols,
      rows,
      cwd: cwd ?? null,
      workspace: spawnEnv ?? currentWorkspaceEnv(),
      blocks: blocks ?? false,
      shell: shell ?? null,
      paneId: paneId ?? null,
      onData,
      onExit,
    });
  } catch (error) {
    releaseHandlers();
    throw error;
  }
  if (!released) receivers.set(id, receiver);
  else clearAgentActivity(id);
  receiver.start();

  let closed = false;
  const sessionId = id;
  const headers = { "x-pty-id": String(sessionId) };

  return {
    id: sessionId,
    // Raw bytes + id header: no JSON round-trip on the per-keystroke path.
    write: (data) =>
      invoke(
        "pty_write",
        typeof data === "string" ? textEncoder.encode(data) : data,
        { headers },
      ),
    resize: (c, r) => invoke("pty_resize", { id: sessionId, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      releaseHandlers();
      await invoke("pty_close", { id: sessionId });
    },
  };
}
