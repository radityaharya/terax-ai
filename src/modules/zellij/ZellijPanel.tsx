import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  deleteAllZellijSessions,
  deleteZellijSession,
  killAllZellijSessions,
  killZellijSession,
  listZellijSessions,
  renameZellijSession,
  type ZellijSessions,
} from "@/modules/ai/lib/native";
import {
  Alert01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Loading03Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  RefreshIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  ZellijConfirmDialog,
  type ZellijConfirmRequest,
} from "./ZellijConfirmDialog";

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

/** What a mutation is currently touching, so the right row shows a spinner. */
type BusyKey = string | null;

/**
 * Lists the zellij sessions running on the active SSH host, opens an attach
 * tab for one, and manages them (rename, stop, delete). Sessions survive the
 * tab closing (and Terax itself) because they live in the remote zellij
 * server, not the PTY.
 */
export function ZellijPanel({ hostId, hostAlias, onAttach }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [nonce, setNonce] = useState(0);
  const [confirm, setConfirm] = useState<ZellijConfirmRequest | null>(null);
  const [busy, setBusy] = useState<BusyKey>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

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

  // Reset transient UI when the host changes: a pending confirm or inline
  // rename belongs to the old host's session list.
  useEffect(() => {
    setConfirm(null);
    setRenaming(null);
    setActionError(null);
    setBusy(null);
  }, [hostId]);

  const run = useCallback(
    async (key: string, label: string, action: () => Promise<void>) => {
      setBusy(key);
      setActionError(null);
      try {
        await action();
        setNonce((n) => n + 1);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(`${label} failed: ${message}`);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const sessions = state.kind === "ready" ? state.data.sessions : [];
  const name = hostAlias || hostId || "this host";

  const confirmRequest = (request: ZellijConfirmRequest) => {
    setConfirm(request);
  };

  // Hold the dialog open while the mutation runs so the destructive action
  // reports progress in place instead of vanishing into a spinner.
  const applyConfirm = async () => {
    if (!hostId || !confirm) return;
    const request = confirm;
    if (request.kind === "kill") {
      await run(request.session, "Stop", () =>
        killZellijSession(hostId, request.session),
      );
    } else if (request.kind === "delete") {
      await run(request.session, "Delete", () =>
        deleteZellijSession(hostId, request.session),
      );
    } else if (request.kind === "kill-all") {
      await run("all", "Stop all", () => killAllZellijSessions(hostId));
    } else {
      await run("all", "Delete all", () => deleteAllZellijSessions(hostId));
    }
    setConfirm(null);
  };

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
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label="Refresh sessions"
            disabled={!hostId || state.kind === "loading"}
            onClick={refresh}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <HugeiconsIcon
              icon={RefreshIcon}
              size={13}
              strokeWidth={1.9}
              className={cn(state.kind === "loading" && "animate-spin")}
            />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Session actions"
                disabled={!hostId || sessions.length === 0}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <HugeiconsIcon
                  icon={MoreHorizontalIcon}
                  size={14}
                  strokeWidth={1.9}
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {sessions.length} session{sessions.length === 1 ? "" : "s"}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 text-xs"
                onSelect={() =>
                  confirmRequest({
                    kind: "kill-all",
                    count: sessions.length,
                  })
                }
              >
                <HugeiconsIcon icon={StopIcon} size={13} strokeWidth={1.9} />
                Stop all sessions
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 text-xs text-destructive focus:text-destructive"
                onSelect={() =>
                  confirmRequest({
                    kind: "delete-all",
                    count: sessions.length,
                  })
                }
              >
                <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.9} />
                Delete all sessions
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {actionError ? (
          <div className="mb-2 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
            <HugeiconsIcon
              icon={Alert01Icon}
              size={13}
              strokeWidth={1.9}
              className="mt-0.5 shrink-0"
            />
            <span className="break-words">{actionError}</span>
          </div>
        ) : null}

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
        ) : sessions.length === 0 ? (
          <Message>
            No zellij sessions on {name}. Start one with{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10.5px]">
              zellij --session dev
            </code>
            .
          </Message>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((session) => (
              <li key={session.name}>
                <SessionRow
                  session={session}
                  busy={busy === session.name}
                  renaming={renaming === session.name}
                  disabled={busy !== null}
                  onAttach={() => hostId && onAttach(hostId, session.name)}
                  onStartRename={() => setRenaming(session.name)}
                  onCancelRename={() => setRenaming(null)}
                  onRename={(next) => {
                    setRenaming(null);
                    if (!hostId || next === session.name) return;
                    void run(session.name, "Rename", () =>
                      renameZellijSession(hostId, session.name, next),
                    );
                  }}
                  onStop={() => confirmRequest({ kind: "kill", session: session.name })}
                  onDelete={() =>
                    confirmRequest({ kind: "delete", session: session.name })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <ZellijConfirmDialog
        request={confirm}
        hostAlias={hostAlias}
        busy={busy !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void applyConfirm()}
      />
    </div>
  );
}

function SessionRow({
  session,
  busy,
  renaming,
  disabled,
  onAttach,
  onStartRename,
  onCancelRename,
  onRename,
  onStop,
  onDelete,
}: {
  session: { name: string; exited: boolean };
  busy: boolean;
  renaming: boolean;
  disabled: boolean;
  onAttach: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRename: (next: string) => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  if (renaming) {
    return (
      <div className="flex h-7 items-center gap-2 rounded-md bg-accent px-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            session.exited ? "bg-muted-foreground/40" : "bg-emerald-500",
          )}
        />
        <RenameInput
          initial={session.name}
          onCommit={onRename}
          onCancel={onCancelRename}
        />
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: the row hosts nested action buttons, so it cannot be a <button>
    <div
      role="button"
      tabIndex={0}
      title={`Attach to ${session.name}`}
      onClick={disabled ? undefined : onAttach}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !disabled) {
          e.preventDefault();
          onAttach();
        }
      }}
      className={cn(
        // Fixed height: the hover action buttons are taller than a single
        // line of text, and letting them size the row made it jump on hover.
        "group flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
        disabled && "cursor-default opacity-60",
        "hover:bg-muted/60",
      )}
    >
      <span
        aria-hidden
        title={session.exited ? "Exited — attach to resurrect" : "Running"}
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          session.exited ? "bg-muted-foreground/40" : "bg-emerald-500",
        )}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
        {session.name}
      </span>

      {busy ? (
        <HugeiconsIcon
          icon={Loading03Icon}
          size={12}
          strokeWidth={2}
          className="shrink-0 animate-spin text-muted-foreground"
        />
      ) : null}
      {session.exited ? (
        <span
          title="Kept on disk but not running — attach to resurrect"
          className="shrink-0 rounded bg-muted px-1 py-px text-[9.5px] uppercase leading-tight tracking-wide text-muted-foreground"
        >
          exited
        </span>
      ) : null}

      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
        <RowButton label={`Attach to ${session.name}`} onClick={onAttach}>
          <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={2} />
        </RowButton>
        <RowButton
          label={`Rename ${session.name}`}
          onClick={onStartRename}
        >
          <HugeiconsIcon
            icon={PencilEdit02Icon}
            size={13}
            strokeWidth={1.9}
          />
        </RowButton>
        {!session.exited ? (
          <RowButton label={`Stop ${session.name}`} onClick={onStop}>
            <HugeiconsIcon icon={StopIcon} size={13} strokeWidth={1.9} />
          </RowButton>
        ) : null}
        <RowButton
          label={`Delete ${session.name}`}
          onClick={onDelete}
          danger
        >
          <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.9} />
        </RowButton>
      </span>
    </div>
  );
}

function RowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground",
        danger && "hover:text-destructive",
      )}
    >
      {children}
    </button>
  );
}

/** Inline rename, committed on Enter and abandoned on Escape or blur. */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label="Rename session"
      spellCheck={false}
      className="h-6 min-w-0 flex-1 rounded-sm bg-background px-1.5 font-mono text-[11.5px] outline-none ring-1 ring-border focus:ring-ring"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          finish(() => onCommit(e.currentTarget.value.trim()));
        } else if (e.key === "Escape") {
          finish(onCancel);
        }
      }}
      onBlur={(e) => {
        if (!document.hasFocus()) return;
        const value = e.currentTarget.value.trim();
        finish(() => (value === initial || !value ? onCancel() : onCommit(value)));
      }}
    />
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
