import { useHostStore } from "@/modules/hosts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { TerminalSearchController } from "@/modules/terminal/search/TerminalSearchController";
import type { WorkspaceEnv } from "@/modules/workspace";
import type { DockerExecTarget, ZellijAttachTarget } from "./lib/pty-bridge";
import { useTheme } from "@/modules/theme";
import {
  forwardRef,
  lazy,
  memo,
  Suspense,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Spinner } from "@/components/ui/spinner";
import type { TerminalBackendKind } from "./backend/contracts";
import { resolvedTerminalBackend } from "./backend/selection";
import {
  useGhosttyTerminalSession,
  ghosttyBlockGeometry,
} from "./ghostty/useGhosttyTerminalSession";
import { ghosttyBlocks } from "./ghostty/ghosttyBlockSessions";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
};

export type TerminalPaneProps = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab and receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  /** Owning tab's env — spawns the shell on this host. */
  env?: WorkspaceEnv;
  /** `docker exec -it` target (overrides the shell spawn). */
  dockerExec?: DockerExecTarget;
  /** Remote zellij session to reattach (overrides the shell spawn). */
  zellijAttach?: ZellijAttachTarget;
  /** Enable command-block decorations (OSC 133) for this terminal. */
  blocks?: boolean;
  onSearchReady?: (leafId: number, addon: TerminalSearchController) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

const TerminalAccessibleOutput = lazy(
  () => import("./ghostty/TerminalAccessibleOutput"),
);
const GhosttyBlockOverlay = lazy(() => import("./ghostty/GhosttyBlockOverlay"));

const GhosttyTerminalPane = memo(
  forwardRef<
    TerminalPaneHandle,
    TerminalPaneProps & {
      backend: Extract<TerminalBackendKind, `ghostty-${string}`>;
    }
  >(function GhosttyTerminalPane(
    {
      leafId,
      visible,
      focused = true,
      initialCwd,
      env,
      dockerExec,
      zellijAttach,
      blocks = false,
      onSearchReady,
      onExit,
      onCwd,
      backend,
    },
    ref,
  ) {
    const screenReader = usePreferencesStore(
      (state) => state.terminalScreenReader,
    );
    const containerRef = useRef<HTMLDivElement>(null);
    const down = useRef<{ x: number; y: number } | null>(null);
    const { resolvedMode, activeTheme } = useTheme();
    const session = useGhosttyTerminalSession({
      leafId,
      backend,
      container: containerRef,
      visible,
      focused,
      initialCwd,
      env,
      dockerExec,
      zellijAttach,
      blocks,
      onSearchReady: (search) => onSearchReady?.(leafId, search),
      onExit: (code) => onExit?.(leafId, code),
      onCwd: (cwd) => onCwd?.(leafId, cwd),
    });

    useEffect(() => {
      void resolvedMode;
      void activeTheme;
      const id = requestAnimationFrame(() => session.applyTheme());
      return () => cancelAnimationFrame(id);
    }, [resolvedMode, activeTheme, session]);

    useImperativeHandle(
      ref,
      () => ({
        write: session.write,
        focus: session.focus,
        getBuffer: session.getBuffer,
        getSelection: session.getSelection,
      }),
      [session],
    );

    return (
      <div
        className="zoom-exempt relative h-full w-full overflow-hidden"
        style={{
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
        onPointerDownCapture={
          blocks
            ? (event) => {
                down.current =
                  event.button === 0 &&
                  event.detail === 1 &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  containerRef.current?.contains(event.target as Node)
                    ? { x: event.clientX, y: event.clientY }
                    : null;
              }
            : undefined
        }
        onPointerUp={
          blocks
            ? (event) => {
                const origin = down.current;
                down.current = null;
                const state = ghosttyBlocks(leafId);
                const geometry = ghosttyBlockGeometry(leafId);
                if (
                  origin &&
                  geometry &&
                  geometry.height > 0 &&
                  Math.hypot(
                    event.clientX - origin.x,
                    event.clientY - origin.y,
                  ) <= 4 &&
                  !state?.model?.trackedSelection?.()
                ) {
                  const row = Math.floor(
                    (event.clientY - geometry.top) / geometry.height,
                  );
                  if (state?.model && row >= 0 && row < state.model.rows)
                    state.controller?.selectAtLine(
                      state.model.bufferLineAtViewportRow(row),
                    );
                }
                if (state?.getMode() === "prompt") state.focus?.();
              }
            : undefined
        }
        data-terminal-backend={backend}
      >
        <div ref={containerRef} className="absolute inset-0" />
        {screenReader && session.model && (
          <Suspense fallback={null}>
            <TerminalAccessibleOutput
              model={session.model}
              visible={visible}
              focused={focused}
              onExit={session.focus}
            />
          </Suspense>
        )}
        {blocks && (
          <Suspense fallback={null}>
            <GhosttyBlockOverlay leafId={leafId} />
          </Suspense>
        )}
        {!session.error && session.connecting && (
          <ConnectingOverlay env={env} onRetry={session.retry} />
        )}
        {!session.error &&
          !session.connecting &&
          session.shellExited &&
          (env?.kind === "ssh" || dockerExec || zellijAttach) && (
            <DisconnectedOverlay
              env={env}
              dockerExec={dockerExec}
              zellijAttach={zellijAttach}
              onReconnect={session.retry}
            />
          )}
        {session.error && (
          <div
            role="alert"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm"
          >
            <strong>
              {session.error.kind === "renderer"
                ? "Unable to display terminal"
                : "Unable to start terminal"}
            </strong>
            <p className="max-w-md break-words text-muted-foreground">
              {session.error.message}
            </p>
            {session.error.kind === "renderer" && (
              <p className="text-muted-foreground">
                Your terminal session is preserved. Retry to restore its
                display.
              </p>
            )}
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 hover:bg-accent focus-visible:outline-2"
              onClick={session.retry}
            >
              {session.error.kind === "renderer" ? "Retry display" : "Retry"}
            </button>
          </div>
        )}
      </div>
    );
  }),
);

/** Non-blocking "connecting" indicator for the window between a terminal
 *  tab opening and its shell/PTY actually spawning (an SSH handshake here
 *  can legitimately take seconds, or hang on a dead host). Delayed by
 *  SHOW_DELAY_MS so local/fast SSH connects never flash it; escalates to
 *  a Retry affordance after STALL_MS so a genuine hang isn't silent. */
const CONNECTING_SHOW_DELAY_MS = 400;
const CONNECTING_STALL_MS = 12_000;

function ConnectingOverlay({
  env,
  onRetry,
}: {
  env: WorkspaceEnv | undefined;
  onRetry: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [stalled, setStalled] = useState(false);
  const hostAlias = useHostStore((state) =>
    env?.kind === "ssh"
      ? (state.hosts.find((h) => h.id === env.hostId)?.alias ?? env.hostId)
      : null,
  );

  useEffect(() => {
    setVisible(false);
    setStalled(false);
    const showTimer = window.setTimeout(
      () => setVisible(true),
      CONNECTING_SHOW_DELAY_MS,
    );
    const stallTimer = window.setTimeout(
      () => setStalled(true),
      CONNECTING_STALL_MS,
    );
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(stallTimer);
    };
    // This component only exists while session.connecting is true (see the
    // conditional render at the call site), so each connecting window is a
    // fresh mount — timers correctly re-arm without extra deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/95 p-6 text-center text-sm"
    >
      <Spinner className="text-muted-foreground" />
      <p className="text-foreground">
        {hostAlias ? `Connecting to ${hostAlias}…` : "Starting terminal…"}
      </p>
      {stalled && (
        <>
          <p className="max-w-sm text-muted-foreground">
            {hostAlias
              ? `This is taking longer than expected. The host may be unreachable, or waiting on authentication.`
              : "This is taking longer than expected."}
          </p>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 hover:bg-accent focus-visible:outline-2"
            onClick={onRetry}
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}

/** Shown when a remote session (SSH / docker exec / zellij attach) drops.
 *  The tab is kept — unlike a local shell exit, which closes the pane — so
 *  the user can reconnect without losing their workspace. */
function DisconnectedOverlay({
  env,
  dockerExec,
  zellijAttach,
  onReconnect,
}: {
  env: WorkspaceEnv | undefined;
  dockerExec?: DockerExecTarget;
  zellijAttach?: ZellijAttachTarget;
  onReconnect: () => void;
}) {
  const hostAlias = useHostStore((state) =>
    env?.kind === "ssh"
      ? (state.hosts.find((h) => h.id === env.hostId)?.alias ?? env.hostId)
      : null,
  );
  const target = dockerExec
    ? dockerExec.container.slice(0, 12)
    : zellijAttach
      ? `zellij ${zellijAttach.session}`
      : hostAlias
        ? hostAlias
        : null;
  return (
    <div
      role="alert"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/95 p-6 text-center text-sm"
    >
      <strong>Connection lost</strong>
      <p className="max-w-md break-words text-muted-foreground">
        {target
          ? `The session on ${target} ended.`
          : "The remote session ended."}{" "}
        Your tab is still here — reconnect to {zellijAttach ? "reattach" : "start a new session"}.
      </p>
      <button
        type="button"
        className="rounded-md border px-3 py-1.5 hover:bg-accent focus-visible:outline-2"
        onClick={onReconnect}
      >
        Reconnect
      </button>
    </div>
  );
}

export const TerminalPane = memo(
  forwardRef<TerminalPaneHandle, TerminalPaneProps>(
    function TerminalPane(props, ref) {
      const [backend] = useState(() =>
        usePreferencesStore.getState().terminalRenderer === "webgl"
          ? ("ghostty-webgl" as const)
          : resolvedTerminalBackend(),
      );
      return <GhosttyTerminalPane ref={ref} {...props} backend={backend} />;
    },
  ),
);
