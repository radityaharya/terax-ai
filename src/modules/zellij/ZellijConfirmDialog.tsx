import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Delete02Icon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export type ZellijConfirmRequest =
  | { kind: "kill"; session: string }
  | { kind: "delete"; session: string }
  | { kind: "kill-all"; count: number }
  | { kind: "delete-all"; count: number };

const COPY: Record<
  ZellijConfirmRequest["kind"],
  {
    title: string;
    label: string;
    destructive: boolean;
    description: string;
    warning?: string;
  }
> = {
  kill: {
    title: "Stop session",
    label: "Stop",
    destructive: false,
    description:
      "Stops every pane in the session. The session stays on disk, so attaching later resurrects it exactly where it left off.",
  },
  delete: {
    title: "Delete session",
    label: "Delete",
    destructive: true,
    description:
      "Removes the session and its saved layout from the host. This cannot be undone.",
    warning: "Anything still running in this session will be killed.",
  },
  "kill-all": {
    title: "Stop all sessions",
    label: "Stop all",
    destructive: false,
    description:
      "Stops every zellij session on this host. Each one stays on disk and can be resurrected by attaching again.",
    warning: "Running programs in every session will be interrupted.",
  },
  "delete-all": {
    title: "Delete all sessions",
    label: "Delete all",
    destructive: true,
    description:
      "Removes every zellij session and its saved layout from this host. This cannot be undone.",
    warning: "Running programs in every session will be killed.",
  },
};

/**
 * Confirmation for a destructive-ish zellij action. Mirrors the Docker
 * confirm dialog so the two remote surfaces read the same way: icon + title,
 * a card naming the target, then the consequence.
 */
export function ZellijConfirmDialog({
  request,
  hostAlias,
  busy,
  onCancel,
  onConfirm,
}: {
  request: ZellijConfirmRequest | null;
  hostAlias?: string | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!request) return null;
  const copy = COPY[request.kind];
  const target =
    request.kind === "kill-all" || request.kind === "delete-all"
      ? `${request.count} session${request.count === 1 ? "" : "s"}`
      : request.session;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="gap-4 p-5 sm:max-w-[440px]">
        <DialogHeader className="gap-1 text-left">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <HugeiconsIcon
              icon={copy.destructive ? Delete02Icon : StopIcon}
              size={16}
              strokeWidth={2}
              className={
                copy.destructive ? "shrink-0 text-destructive" : "shrink-0 text-amber-500"
              }
            />
            <span>{copy.title}</span>
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-muted-foreground">
            {copy.description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5 rounded-md border border-border/70 bg-muted/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Session
            </span>
            {hostAlias ? (
              <span className="truncate text-[10px] text-muted-foreground/80">
                Host: <span className="font-mono text-foreground">{hostAlias}</span>
              </span>
            ) : null}
          </div>
          <div className="break-all font-mono text-xs font-semibold text-foreground">
            {target}
          </div>
        </div>

        {copy.warning ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">
            {copy.warning}
          </div>
        ) : null}

        <DialogFooter className="gap-2 pt-1 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onCancel}
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={copy.destructive ? "destructive" : "default"}
            size="sm"
            disabled={busy}
            onClick={onConfirm}
            className="h-8 text-xs font-medium"
          >
            {busy ? "Working…" : copy.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
