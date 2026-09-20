import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Alert02Icon,
  Delete02Icon,
  PlayIcon,
  RotateClockwiseIcon,
  StopIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDockerConfirmStore } from "../lib/dockerConfirmStore";

function actionIcon(actionLabel: string, variant?: string) {
  const norm = actionLabel.toLowerCase();
  if (norm.includes("kill")) {
    return (
      <HugeiconsIcon
        icon={ZapIcon}
        size={16}
        strokeWidth={2}
        className="shrink-0 text-destructive"
      />
    );
  }
  if (
    norm.includes("remove") ||
    norm.includes("prune") ||
    norm.includes("delete")
  ) {
    return (
      <HugeiconsIcon
        icon={Delete02Icon}
        size={16}
        strokeWidth={2}
        className="shrink-0 text-destructive"
      />
    );
  }
  if (norm.includes("restart")) {
    return (
      <HugeiconsIcon
        icon={RotateClockwiseIcon}
        size={16}
        strokeWidth={2}
        className="shrink-0 text-amber-500"
      />
    );
  }
  if (norm.includes("stop") || norm.includes("down") || norm.includes("drain")) {
    return (
      <HugeiconsIcon
        icon={StopIcon}
        size={16}
        strokeWidth={2}
        className="shrink-0 text-amber-500"
      />
    );
  }
  if (norm.includes("start") || norm.includes("activate") || norm.includes("up")) {
    return (
      <HugeiconsIcon
        icon={PlayIcon}
        size={16}
        strokeWidth={2}
        className="shrink-0 text-emerald-500"
      />
    );
  }
  if (variant === "destructive") {
    return (
      <HugeiconsIcon
        icon={Alert02Icon}
        size={16}
        strokeWidth={2}
        className="shrink-0 text-destructive"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={Alert02Icon}
      size={16}
      strokeWidth={2}
      className="shrink-0 text-primary"
    />
  );
}

export function DockerConfirmDialog() {
  const pending = useDockerConfirmStore((s) => s.pending);
  const confirm = useDockerConfirmStore((s) => s.confirm);
  const cancel = useDockerConfirmStore((s) => s.cancel);

  if (!pending) return null;

  const isDestructive = pending.actionVariant === "destructive";

  return (
    <Dialog
      open={Boolean(pending)}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent className="gap-4 p-5 sm:max-w-[440px]">
        <DialogHeader className="gap-1 text-left">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {actionIcon(pending.actionLabel, pending.actionVariant)}
            <span>{pending.title}</span>
          </DialogTitle>
          {pending.description ? (
            <DialogDescription className="text-xs leading-relaxed text-muted-foreground">
              {pending.description}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {/* Resource card: clearly highlights the target entity being manipulated */}
        <div className="flex flex-col gap-1.5 rounded-md border border-border/70 bg-muted/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {pending.resourceKind}
            </span>
            {pending.hostAlias ? (
              <span className="truncate text-[10px] text-muted-foreground/80">
                Host:{" "}
                <span className="font-mono text-foreground">
                  {pending.hostAlias}
                </span>
              </span>
            ) : null}
          </div>

          <div
            className="break-all font-mono text-xs font-semibold text-foreground"
            title={pending.resourceName}
          >
            {pending.resourceName}
          </div>

          {pending.resourceDetails ? (
            <div
              className="break-all font-mono text-[11px] text-muted-foreground"
              title={pending.resourceDetails}
            >
              {pending.resourceDetails}
            </div>
          ) : null}
        </div>

        {pending.warning ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">
            {pending.warning}
          </div>
        ) : null}

        <DialogFooter className="gap-2 pt-1 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancel}
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={isDestructive ? "destructive" : "default"}
            size="sm"
            onClick={confirm}
            className="h-8 text-xs font-medium"
          >
            {pending.actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
