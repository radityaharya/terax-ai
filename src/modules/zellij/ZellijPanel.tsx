import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  Alert01Icon,
  Loading03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { listZellijSessions } from "@/modules/ai/lib/native";
import type { ZellijSessions } from "@/modules/ai/lib/native";
import { cn } from "@/lib/utils";

type Props = {
  /** Active SSH host, or null when the active tab isn't on an SSH host. */
  hostId: string | null;
  hostAlias?: string | null;
  /** Open a terminal tab reattaching to `session` on this host. */
  onAttach: (hostId: string, session: string) => void;
};

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: ZellijSessions }
  | { kind: "error"; message: string };

/**
 * Lists the zellij sessions running on the active SSH host and opens an
 * attach tab for one. Sessions survive the tab closing (and Terax
 * itself) because they live in the remote zellij server, not the PTY.
 */
export function ZellijPanel({ hostId, hostAlias, onAttach }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!hostId) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    listZellijSessions(hostId)
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, nonce]);

  const name = hostAlias || hostId || "this host";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[12px] font-medium">
            Zellij sessions
          </span>
          <span className="truncate text-[10.5px] text-muted-foreground">
            {hostId ? name : "No SSH host"}
          </span>
        </div>
        <button
          type="button"
          aria-label="Refresh sessions"
          disabled={!hostId || state.kind === "loading"}
          onClick={refresh}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={13}
            strokeWidth={1.9}
            className={cn(state.kind === "loading" && "animate-spin")}
          />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {!hostId ? (
          <Message>
            Open a terminal on an SSH host to see its zellij sessions.
          </Message>
        ) : state.kind === "loading" || state.kind === "idle" ? (
          <Message>
            <HugeiconsIcon
              icon={Loading03Icon}
              size={14}
              strokeWidth={1.9}
              className="animate-spin"
            />
            <span className="ml-1.5">Looking for sessions…</span>
          </Message>
        ) : state.kind === "error" ? (
          <Message tone="error">
            <span className="flex items-start gap-1.5">
              <HugeiconsIcon
                icon={Alert01Icon}
                size={14}
                strokeWidth={1.9}
                className="mt-0.5 shrink-0"
              />
              <span className="break-words">{state.message}</span>
            </span>
            <button
              type="button"
              onClick={refresh}
              className="mt-2 rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-accent"
            >
              Retry
            </button>
          </Message>
        ) : !state.data.available ? (
          <Message>
            Zellij isn't installed on {name}. Install it there, then refresh.
          </Message>
        ) : state.data.sessions.length === 0 ? (
          <Message>
            No zellij sessions on {name}. Start one with{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10.5px]">
              zellij --session dev
            </code>
            .
          </Message>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {state.data.sessions.map((session) => (
              <li key={session.name}>
                <button
                  type="button"
                  onClick={() => onAttach(hostId, session.name)}
                  className="group flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60"
                >
                  <span className="truncate font-mono text-[11.5px]">
                    {session.name}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    Attach
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Message({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "rounded-md px-2 py-2 text-[11.5px] leading-relaxed",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
