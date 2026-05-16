import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { IS_MAC } from "@/lib/platform";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  Alert02Icon,
  ArrowReloadHorizontalIcon,
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  GitBranchIcon,
  MinusSignIcon,
  PlusSignIcon,
  Refresh01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { SourceControlSummary } from "./useSourceControl";
import {
  useSourceControlPanel,
  type SourceControlEntry,
} from "./useSourceControlPanel";

type Props = {
  open: boolean;
  sourceControl: SourceControlSummary;
  onOpenDiff: (input: {
    path: string;
    repoRoot: string;
    mode: "+" | "-";
    originalContent: string;
    modifiedContent: string;
    isBinary: boolean;
    fallbackPatch: string;
  }) => void;
};

const SOURCE_CONTROL_TOOLTIP_CLASS =
  "border border-border/70 bg-zinc-950 text-zinc-100 shadow-lg shadow-black/30 dark:border-border/60 dark:bg-zinc-950 dark:text-zinc-100";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "";
  return normalized.slice(0, index);
}

function entryPathLabel(entry: SourceControlEntry): string {
  if (entry.originalPath) {
    return `${entry.originalPath} → ${entry.path}`;
  }
  return dirname(entry.path);
}

function upstreamBadgeLabel(upstream: string | null | undefined): string {
  if (!upstream) return "No upstream";
  const [remote] = upstream.split("/");
  return remote || upstream;
}

function statusTone(statusCode: string): string {
  switch (statusCode) {
    case "A":
    case "?":
      return "text-emerald-600 dark:text-emerald-400";
    case "M":
      return "text-amber-600 dark:text-amber-300";
    case "D":
      return "text-rose-600 dark:text-rose-400";
    case "R":
      return "text-sky-600 dark:text-sky-300";
    default:
      return "text-muted-foreground";
  }
}

function statusDotBg(statusCode: string): string {
  switch (statusCode) {
    case "A":
    case "?":
      return "bg-emerald-500/15";
    case "M":
      return "bg-amber-500/15";
    case "D":
      return "bg-rose-500/15";
    case "R":
      return "bg-sky-500/15";
    default:
      return "bg-muted/40";
  }
}

export const SourceControlPanel = memo(function SourceControlPanel({
  open,
  sourceControl,
  onOpenDiff,
}: Props) {
  const refreshAnimationRef = useRef<number | null>(null);
  const [refreshAnimating, setRefreshAnimating] = useState(false);
  const scm = useSourceControlPanel(open, sourceControl, onOpenDiff);

  useEffect(() => {
    return () => {
      if (refreshAnimationRef.current) {
        window.clearTimeout(refreshAnimationRef.current);
      }
    };
  }, []);

  const isRefreshing = scm.panelState === "loading" || scm.diffLoading;
  const repoLabel = useMemo(() => {
    if (!scm.status) return "Source Control";
    return scm.status.isDetached ? "detached" : scm.status.branch;
  }, [scm.status]);

  const commitShortcut = IS_MAC ? "⌘+Enter" : "Ctrl+Enter";
  const canCommit =
    scm.stagedEntries.length > 0 &&
    scm.commitMessage.trim().length > 0 &&
    !scm.actionBusy;
  const commitDisabledReason = scm.actionBusy
    ? "Wait for the current Git action to finish."
    : scm.stagedEntries.length === 0
      ? "Stage changes to enable commit."
      : scm.commitMessage.trim().length === 0
        ? "Enter a commit message to enable commit."
        : null;
  const commitHint = canCommit
    ? `Commit with ${commitShortcut}.`
    : (commitDisabledReason ?? `Commit with ${commitShortcut}.`);
  const pushHint = scm.pushHint ?? "Push is unavailable right now.";
  const pushDisabledReason = scm.actionBusy
    ? "Wait for the current Git action to finish."
    : pushHint;
  const stagedCount = scm.stagedEntries.length;
  const stagedCountLabel = `${stagedCount} staged`;
  const commitStatusLabel = scm.actionBusy
    ? "Git action in progress"
    : stagedCount === 0
      ? "Stage files first"
      : scm.commitMessage.trim().length === 0
        ? "Message required"
        : `Ready: ${stagedCount} ${stagedCount === 1 ? "file" : "files"}`;
  const pushStatusLabel = upstreamBadgeLabel(scm.status?.upstream);
  const footerFeedback = useMemo(() => {
    if (scm.actionError) {
      return { tone: "error", message: scm.actionError } as const;
    }
    if (scm.remoteError) {
      return { tone: "error", message: scm.remoteError } as const;
    }
    if (scm.actionMessage) {
      return { tone: "success", message: scm.actionMessage } as const;
    }
    return null;
  }, [scm.actionError, scm.actionMessage, scm.remoteError]);

  const handleCommitShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    if (!canCommit) return;
    event.preventDefault();
    void scm.commit();
  };

  const handleRefresh = () => {
    setRefreshAnimating(true);
    if (refreshAnimationRef.current) {
      window.clearTimeout(refreshAnimationRef.current);
    }
    void scm.refresh().finally(() => {
      refreshAnimationRef.current = window.setTimeout(() => {
        setRefreshAnimating(false);
        refreshAnimationRef.current = null;
      }, 450);
    });
  };

  if (!open) return null;

  return (
    <TooltipProvider delayDuration={800} skipDelayDuration={300}>
      <aside
        className="flex h-full min-w-0 flex-col bg-card/80 backdrop-blur [contain:layout_style]"
      >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Source Control
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <IconActionButton
                label="Refresh source control"
                disabled={isRefreshing || !!scm.actionBusy}
                onClick={handleRefresh}
              >
                {isRefreshing ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <HugeiconsIcon
                    icon={Refresh01Icon}
                    size={14}
                    strokeWidth={1.9}
                    className={cn(refreshAnimating && "animate-spin")}
                  />
                )}
              </IconActionButton>
            </div>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <div className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11.5px] font-semibold leading-none text-foreground">
              <HugeiconsIcon
                icon={GitBranchIcon}
                size={11}
                strokeWidth={1.9}
                className="shrink-0 text-muted-foreground"
              />
              <span className="truncate">{repoLabel}</span>
            </div>
            {scm.status && (scm.status.ahead > 0 || scm.status.behind > 0) ? (
              <div className="flex shrink-0 items-center gap-1 text-[10px] font-medium tabular-nums leading-none text-muted-foreground">
                {scm.status.ahead > 0 ? (
                  <span className="inline-flex items-center gap-0.5 rounded bg-sky-500/15 px-1 py-0.5 text-sky-600 dark:text-sky-300">
                    ↑{scm.status.ahead}
                  </span>
                ) : null}
                {scm.status.behind > 0 ? (
                  <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-amber-600 dark:text-amber-300">
                    ↓{scm.status.behind}
                  </span>
                ) : null}
              </div>
            ) : null}
            {scm.status?.isDetached ? (
              <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-300">
                detached
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {scm.panelState === "loading" ? (
        <PanelCenter title="Loading repository" />
      ) : null}

      {scm.panelState === "no-repo" ? (
        <PanelCenter
          title="No repository"
          body="The active workspace is not inside a Git repository."
        />
      ) : null}

      {scm.panelState === "error" ? (
        <PanelCenter
          title="Source control error"
          body={scm.statusError ?? "Unknown source control error"}
          action={
            <Button size="sm" onClick={() => void scm.refresh()}>
              Retry
            </Button>
          }
        />
      ) : null}

      {scm.panelState === "ready" && scm.status ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {scm.status.ahead > 0 && scm.status.behind > 0 ? (
            <div className="mx-2 mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-700 dark:text-amber-200">
              <HugeiconsIcon
                icon={Alert02Icon}
                size={13}
                strokeWidth={1.9}
                className="mt-px shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium">Branch diverged from upstream</div>
                <div className="opacity-80">
                  Open a terminal to merge or rebase before syncing.
                </div>
              </div>
            </div>
          ) : null}
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-2.5 p-2">
              {scm.allClean ? (
                <div className="flex flex-col items-center justify-center gap-2 px-4 py-6 text-center">
                  <div className="flex size-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    <HugeiconsIcon
                      icon={CheckmarkCircle01Icon}
                      size={18}
                      strokeWidth={1.75}
                    />
                  </div>
                  <div className="text-[12px] font-medium">Working tree clean</div>
                  <div className="text-[10.5px] leading-snug text-muted-foreground">
                    No staged or unstaged changes on{" "}
                    <span className="font-mono text-foreground/80">
                      {repoLabel}
                    </span>
                    .
                  </div>
                </div>
              ) : (
                <>
                  <ChangeGroup
                    title="Staged Changes"
                    entries={scm.stagedEntries}
                    selected={scm.selected}
                    actionBusy={scm.actionBusy}
                    empty={scm.stagedEmptyText}
                    defaultOpen
                    actionType="unstage"
                    onActionAll={scm.unstageAllEntries}
                    onSelect={scm.selectEntry}
                    onAction={scm.unstageEntry}
                  />
                  <ChangeGroup
                    title="Changes"
                    entries={scm.unstagedEntries}
                    selected={scm.selected}
                    actionBusy={scm.actionBusy}
                    empty={scm.unstagedEmptyText}
                    defaultOpen
                    actionType="stage"
                    onActionAll={scm.stageAllEntries}
                    onDiscardAll={() => scm.requestDiscardAll()}
                    onSelect={scm.selectEntry}
                    onAction={scm.stageEntry}
                    onDiscard={(entry) => scm.requestDiscardEntry(entry)}
                  />
                </>
              )}
            </div>
          </ScrollArea>

          <Separator />

          <div className="relative border-t border-border/30 bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/90 space-y-1.5 p-2">
            <div className="relative">
              <Textarea
                value={scm.commitMessage}
                onChange={(event) => scm.setCommitMessage(event.target.value)}
                onKeyDown={handleCommitShortcut}
                placeholder="Commit message"
                rows={1}
                className={cn(
                  "min-h-10 resize-none rounded-lg border border-border/60 bg-background/95 py-2 pl-2.5 pr-8 text-[12.5px] leading-snug shadow-none placeholder:text-muted-foreground/80 focus-visible:border-border/60 focus-visible:ring-0",
                )}
              />
              <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
                <IconActionButton
                  label={scm.generateCommitMessageHint}
                  disabled={!scm.canGenerateCommitMessage}
                  side="top"
                  onClick={() => void scm.generateCommitMessage()}
                >
                  {scm.actionBusy === "generate-message" ? (
                    <Spinner className="size-3" />
                  ) : (
                    <HugeiconsIcon
                      icon={SparklesIcon}
                      size={12}
                      strokeWidth={2}
                    />
                  )}
                </IconActionButton>
              </div>
            </div>

            <div className="flex min-w-0 items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        canCommit ? "bg-emerald-500" : "bg-muted-foreground/45",
                      )}
                    />
                    <span className="truncate">{commitStatusLabel}</span>
                    <span className="shrink-0 text-muted-foreground/70">
                      {stagedCountLabel}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className={cn(SOURCE_CONTROL_TOOLTIP_CLASS, "text-[10.5px]")}
                >
                  {commitHint}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="min-w-0 shrink-0 truncate text-right text-muted-foreground/80">
                    {pushStatusLabel}
                  </div>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className={cn(
                    SOURCE_CONTROL_TOOLTIP_CLASS,
                    "max-w-64 text-[10.5px]",
                  )}
                >
                  {pushHint}
                </TooltipContent>
              </Tooltip>
            </div>

            <CommitFeedback feedback={footerFeedback} />

            <div className="grid grid-cols-2 gap-1.5">
              <Button
                size="xs"
                className="w-full cursor-pointer disabled:cursor-not-allowed"
                disabled={!canCommit}
                title={commitDisabledReason ?? `Commit (${commitShortcut})`}
                onClick={() => void scm.commit()}
              >
                {scm.actionBusy === "commit" ? "Committing..." : "Commit"}
              </Button>
              <Button
                size="xs"
                variant="secondary"
                className="w-full cursor-pointer disabled:cursor-not-allowed"
                disabled={!scm.canPush || !!scm.actionBusy}
                title={pushDisabledReason}
                onClick={() => void scm.push()}
              >
                {scm.actionBusy === "push" ? "Pushing..." : "Push"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      </aside>
      <AlertDialog
        open={scm.pendingDiscard !== null}
        onOpenChange={(open) => {
          if (!open) scm.cancelPendingDiscard();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {scm.pendingDiscard?.scope === "all"
                ? `This will discard ${scm.pendingDiscard.label} and cannot be undone.`
                : scm.pendingDiscard
                  ? `Discard changes in "${scm.pendingDiscard.label}"? This cannot be undone.`
                  : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => scm.cancelPendingDiscard()}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void scm.confirmPendingDiscard()}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
});

function PanelCenter({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-sm font-medium">{title}</div>
      {body ? (
        <div className="max-w-64 text-[11px] leading-relaxed text-muted-foreground">
          {body}
        </div>
      ) : null}
      {action}
    </div>
  );
}

function ChangeGroup({
  title,
  entries,
  selected,
  actionBusy,
  empty,
  defaultOpen,
  actionType,
  onActionAll,
  onDiscardAll,
  onSelect,
  onAction,
  onDiscard,
}: {
  title: string;
  entries: SourceControlEntry[];
  selected: { path: string; mode: "-" | "+" } | null;
  actionBusy: string | null;
  empty: string;
  defaultOpen?: boolean;
  actionType: "stage" | "unstage";
  onActionAll: () => Promise<void> | void;
  onDiscardAll?: () => Promise<void> | void;
  onSelect: (entry: SourceControlEntry) => Promise<void>;
  onAction: (entry: SourceControlEntry) => Promise<void>;
  onDiscard?: (entry: SourceControlEntry) => Promise<void> | void;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? false);
  const actionIcon = actionType === "stage" ? PlusSignIcon : MinusSignIcon;
  const actionLabel = actionType === "stage" ? "Stage" : "Unstage";
  const isHeaderActionBusy = actionBusy === `${actionType}:all`;
  const isDiscardAllBusy = actionBusy === "discard:all";

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="space-y-1">
      <div className="flex items-center gap-2">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-foreground px-1 py-0.5"
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                size={12}
                strokeWidth={2.15}
                className={cn(
                  "transition-transform",
                  isOpen && "rotate-90",
                )}
              />
            </span>
            <span className="truncate text-[10px] font-semibold uppercase tracking-[0.14em]">
              {title}
            </span>
            <span className="text-[10px] text-muted-foreground/80">
              {entries.length}
            </span>
          </button>
        </CollapsibleTrigger>

        <div className="flex items-center gap-0.5">
          {onDiscardAll ? (
            <IconActionButton
              label="Discard all changes"
              disabled={actionBusy !== null || entries.length === 0}
              onClick={() => void onDiscardAll()}
            >
              {isDiscardAllBusy ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon
                  icon={ArrowReloadHorizontalIcon}
                  size={11}
                  strokeWidth={2}
                />
              )}
            </IconActionButton>
          ) : null}
          <IconActionButton
            label={`${actionLabel} all files`}
            disabled={actionBusy !== null || entries.length === 0}
            onClick={() => void onActionAll()}
          >
            {isHeaderActionBusy ? (
              <Spinner className="size-3" />
            ) : (
              <HugeiconsIcon icon={actionIcon} size={11} strokeWidth={2} />
            )}
          </IconActionButton>
        </div>
      </div>

      <CollapsibleContent>
        {entries.length === 0 ? (
          <div className="px-1.5 py-1 text-[11px] text-muted-foreground">
            {empty}
          </div>
        ) : (
          <ul className="space-y-px">
            {entries.map((entry) => {
              const isSelected =
                selected?.path === entry.path && selected.mode === entry.mode;
              const fileName = basename(entry.path);
              const iconUrl = fileIconUrl(fileName);
              const pathLabel = entryPathLabel(entry);

              return (
                <li key={entry.key}>
                  <div
                    className={cn(
                      "group flex items-center gap-1.5 rounded-md border border-transparent px-1 py-0.5 transition-colors",
                      isSelected
                        ? "bg-accent/80 text-foreground"
                        : "hover:bg-accent/45",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex size-4 shrink-0 items-center justify-center rounded text-[9.5px] font-bold leading-none tabular-nums",
                        statusDotBg(entry.statusCode),
                        statusTone(entry.statusCode),
                      )}
                      title={entry.statusLabel}
                    >
                      {entry.statusCode}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => void onSelect(entry)}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                        >
                          {iconUrl ? (
                            <img
                              src={iconUrl}
                              alt=""
                              className="size-3.5 shrink-0"
                            />
                          ) : (
                            <span className="size-3.5 shrink-0" />
                          )}
                          <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
                            <span
                              className={cn(
                                "truncate text-[11.5px] font-medium leading-tight",
                                pathLabel
                                  ? "max-w-[60%] shrink-0"
                                  : "min-w-0 flex-1",
                              )}
                            >
                              {fileName}
                            </span>
                            {pathLabel ? (
                              <span className="min-w-0 flex-1 truncate text-[10px] leading-tight text-muted-foreground">
                                {pathLabel}
                              </span>
                            ) : null}
                          </div>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        className={cn(
                          SOURCE_CONTROL_TOOLTIP_CLASS,
                          "text-[10.5px]",
                        )}
                      >
                        {`${actionLabel} ${entry.path}`}
                      </TooltipContent>
                    </Tooltip>

                    <EntryActions
                      entry={entry}
                      busy={actionBusy === `${actionType}:${entry.path}`}
                      discardBusy={actionBusy === `discard:${entry.path}`}
                      disabled={actionBusy !== null}
                      label={`${actionLabel} ${entry.path}`}
                      icon={actionIcon}
                      onClick={() => void onAction(entry)}
                      onDiscard={
                        onDiscard
                          ? () => void onDiscard(entry)
                          : undefined
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function EntryActions({
  entry,
  busy,
  discardBusy,
  disabled,
  label,
  icon,
  onClick,
  onDiscard,
}: {
  entry: SourceControlEntry;
  busy: boolean;
  discardBusy: boolean;
  disabled?: boolean;
  label: string;
  icon: typeof PlusSignIcon;
  onClick: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      {onDiscard ? (
        <IconActionButton
          label={`Discard ${entry.path}`}
          disabled={disabled}
          side="top"
          onClick={onDiscard}
        >
          {discardBusy ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon
              icon={ArrowReloadHorizontalIcon}
              size={11}
              strokeWidth={2}
            />
          )}
        </IconActionButton>
      ) : null}
      <IconActionButton
        label={label}
        disabled={disabled}
        side="top"
        onClick={onClick}
      >
        {busy ? (
          <Spinner className="size-3" />
        ) : (
          <HugeiconsIcon icon={icon} size={11} strokeWidth={2} />
        )}
      </IconActionButton>
    </div>
  );
}

function IconActionButton({
  label,
  disabled,
  side = "left",
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  side?: "left" | "top";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          className="cursor-pointer rounded-md text-muted-foreground disabled:cursor-not-allowed"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className={cn(SOURCE_CONTROL_TOOLTIP_CLASS, "text-[10.5px]")}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function CommitFeedback({
  feedback,
}: {
  feedback: { tone: "error" | "success"; message: string } | null;
}) {
  const [visibleFeedback, setVisibleFeedback] = useState(feedback);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!feedback) {
      setIsVisible(false);
      return;
    }

    setVisibleFeedback(feedback);
    setIsVisible(true);

    const hideTimer = window.setTimeout(() => setIsVisible(false), 3600);
    const clearTimer = window.setTimeout(() => {
      setVisibleFeedback((current) =>
        current?.message === feedback.message && current.tone === feedback.tone
          ? null
          : current,
      );
    }, 3900);

    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
    };
  }, [feedback]);

  if (!visibleFeedback) return null;

  const isError = visibleFeedback.tone === "error";

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-3 bottom-[calc(100%-0.35rem)] z-20 flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg shadow-black/15 backdrop-blur transition-all duration-200",
        isVisible
          ? "translate-y-0 opacity-100"
          : "translate-y-1 opacity-0",
        isError
          ? "border-destructive/30 bg-card/95 text-destructive"
          : "border-border/70 bg-card/95 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError ? "bg-destructive" : "bg-emerald-500",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          isError ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {visibleFeedback.message}
      </span>
    </div>
  );
}
