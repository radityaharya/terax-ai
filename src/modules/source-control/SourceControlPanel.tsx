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
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowReloadHorizontalIcon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  CloudIcon,
  GitBranchIcon,
  MinusSignIcon,
  PlusSignIcon,
  Refresh01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  memo,
  useCallback,
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
    title?: string;
  }) => void;
  onOpenHistory?: () => void;
};

const SOURCE_CONTROL_TOOLTIP_CLASS =
  "border border-border/70 bg-zinc-950 text-zinc-100 shadow-lg shadow-black/30 dark:border-border/60 dark:bg-zinc-950 dark:text-zinc-100";

const ROW_HEIGHTS = {
  banner: 56,
  groupHeader: 28,
  entry: 30,
  emptyPlaceholder: 24,
} as const;

type GroupId = "staged" | "unstaged";

type RowDescriptor =
  | { kind: "banner-diverged"; key: string }
  | { kind: "group-header"; key: string; group: GroupId; count: number }
  | { kind: "entry"; key: string; group: GroupId; entry: SourceControlEntry }
  | { kind: "empty"; key: string; group: GroupId; text: string };

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
  if (entry.originalPath) return `${entry.originalPath} → ${entry.path}`;
  return dirname(entry.path);
}

function upstreamBadgeLabel(upstream: string | null | undefined): string {
  if (!upstream) return "No upstream";
  return upstream;
}

function statusTone(code: string): string {
  switch (code) {
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

export const SourceControlPanel = memo(function SourceControlPanel({
  open,
  sourceControl,
  onOpenDiff,
  onOpenHistory,
}: Props) {
  const scm = useSourceControlPanel(open, sourceControl, onOpenDiff);
  const refreshAnimationRef = useRef<number | null>(null);
  const [refreshAnimating, setRefreshAnimating] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);

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

  const commitShortcut = IS_MAC ? "⌘↩" : "Ctrl+Enter";
  const generateShortcut = IS_MAC ? "⌘G" : "Ctrl+G";
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
  const unstagedCount = scm.unstagedEntries.length;
  const pushStatusLabel = upstreamBadgeLabel(scm.status?.upstream);
  const hasUpstream = !!scm.status?.upstream;
  const isDiverged =
    !!scm.status && scm.status.ahead > 0 && scm.status.behind > 0;

  const canPull =
    hasUpstream &&
    !!scm.status &&
    scm.status.behind > 0 &&
    !isDiverged &&
    !scm.actionBusy &&
    !sourceControl.busyAction;
  const canFetch =
    hasUpstream && !scm.actionBusy && !sourceControl.busyAction;

  const footerFeedback = useMemo(() => {
    if (scm.actionError) return { tone: "error", message: scm.actionError } as const;
    if (scm.remoteError) return { tone: "error", message: scm.remoteError } as const;
    if (scm.actionMessage) return { tone: "success", message: scm.actionMessage } as const;
    return null;
  }, [scm.actionError, scm.actionMessage, scm.remoteError]);

  const handleCommitShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      canCommit
    ) {
      event.preventDefault();
      void scm.commit();
      return;
    }
    if (
      event.key.toLowerCase() === "g" &&
      (event.metaKey || event.ctrlKey) &&
      scm.canGenerateCommitMessage
    ) {
      event.preventDefault();
      void scm.generateCommitMessage();
    }
  };

  const handleRefresh = useCallback(() => {
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
  }, [scm]);

  const handleFetch = useCallback(() => {
    void sourceControl.runRemoteAction("fetch");
  }, [sourceControl]);

  const handlePull = useCallback(() => {
    void sourceControl.runRemoteAction("pull");
  }, [sourceControl]);

  const rows = useMemo<RowDescriptor[]>(() => {
    const result: RowDescriptor[] = [];
    if (isDiverged) {
      result.push({ kind: "banner-diverged", key: "banner-diverged" });
    }

    result.push({
      kind: "group-header",
      key: "header-staged",
      group: "staged",
      count: stagedCount,
    });
    if (stagedOpen) {
      if (stagedCount === 0) {
        result.push({
          kind: "empty",
          key: "empty-staged",
          group: "staged",
          text: scm.stagedEmptyText,
        });
      } else {
        for (const entry of scm.stagedEntries) {
          result.push({
            kind: "entry",
            key: `staged:${entry.key}`,
            group: "staged",
            entry,
          });
        }
      }
    }

    result.push({
      kind: "group-header",
      key: "header-unstaged",
      group: "unstaged",
      count: unstagedCount,
    });
    if (unstagedOpen) {
      if (unstagedCount === 0) {
        result.push({
          kind: "empty",
          key: "empty-unstaged",
          group: "unstaged",
          text: scm.unstagedEmptyText,
        });
      } else {
        for (const entry of scm.unstagedEntries) {
          result.push({
            kind: "entry",
            key: `unstaged:${entry.key}`,
            group: "unstaged",
            entry,
          });
        }
      }
    }

    return result;
  }, [
    isDiverged,
    scm.stagedEmptyText,
    scm.stagedEntries,
    scm.unstagedEmptyText,
    scm.unstagedEntries,
    stagedCount,
    stagedOpen,
    unstagedCount,
    unstagedOpen,
  ]);

  const rowKeyToIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.key, index));
    return map;
  }, [rows]);

  useEffect(() => {
    if (!focusedRowKey) return;
    if (!rowKeyToIndex.has(focusedRowKey)) {
      setFocusedRowKey(null);
    }
  }, [focusedRowKey, rowKeyToIndex]);

  const focusableIndices = useMemo(() => {
    const out: number[] = [];
    rows.forEach((row, index) => {
      if (row.kind === "entry") out.push(index);
    });
    return out;
  }, [rows]);

  const estimateSize = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return ROW_HEIGHTS.entry;
      switch (row.kind) {
        case "banner-diverged":
          return ROW_HEIGHTS.banner;
        case "group-header":
          return ROW_HEIGHTS.groupHeader;
        case "entry":
          return ROW_HEIGHTS.entry;
        case "empty":
          return ROW_HEIGHTS.emptyPlaceholder;
      }
    },
    [rows],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const moveFocus = useCallback(
    (direction: 1 | -1) => {
      if (focusableIndices.length === 0) return;
      const currentIndex =
        focusedRowKey === null
          ? -1
          : rowKeyToIndex.get(focusedRowKey) ?? -1;
      let pos = focusableIndices.findIndex((i) => i === currentIndex);
      if (pos === -1) pos = direction > 0 ? -1 : focusableIndices.length;
      let nextPos = pos + direction;
      if (nextPos < 0) nextPos = 0;
      if (nextPos > focusableIndices.length - 1)
        nextPos = focusableIndices.length - 1;
      const targetRowIndex = focusableIndices[nextPos];
      const target = rows[targetRowIndex];
      if (!target) return;
      setFocusedRowKey(target.key);
      virtualizer.scrollToIndex(targetRowIndex, { align: "auto" });
    },
    [focusableIndices, focusedRowKey, rowKeyToIndex, rows, virtualizer],
  );

  const activateFocused = useCallback(() => {
    if (!focusedRowKey) return;
    const index = rowKeyToIndex.get(focusedRowKey);
    if (index === undefined) return;
    const row = rows[index];
    if (!row || row.kind !== "entry") return;
    void scm.selectEntry(row.entry);
  }, [focusedRowKey, rowKeyToIndex, rows, scm]);

  const toggleStageFocused = useCallback(() => {
    if (!focusedRowKey) return;
    const index = rowKeyToIndex.get(focusedRowKey);
    if (index === undefined) return;
    const row = rows[index];
    if (!row || row.kind !== "entry") return;
    if (row.group === "staged") void scm.unstageEntry(row.entry);
    else void scm.stageEntry(row.entry);
  }, [focusedRowKey, rowKeyToIndex, rows, scm]);

  const discardFocused = useCallback(() => {
    if (!focusedRowKey) return;
    const index = rowKeyToIndex.get(focusedRowKey);
    if (index === undefined) return;
    const row = rows[index];
    if (!row || row.kind !== "entry" || row.group !== "unstaged") return;
    scm.requestDiscardEntry(row.entry);
  }, [focusedRowKey, rowKeyToIndex, rows, scm]);

  const handlePanelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "TEXTAREA" || target.tagName === "INPUT")
      ) {
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta && (event.key === "r" || event.key === "R")) {
        event.preventDefault();
        handleRefresh();
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(-1);
          break;
        case "Enter":
          if (focusedRowKey) {
            event.preventDefault();
            activateFocused();
          }
          break;
        case "s":
        case "S":
          if (!meta) {
            event.preventDefault();
            toggleStageFocused();
          }
          break;
        case "d":
        case "D":
          if (!meta) {
            event.preventDefault();
            discardFocused();
          }
          break;
      }
    },
    [
      activateFocused,
      discardFocused,
      focusedRowKey,
      handleRefresh,
      moveFocus,
      toggleStageFocused,
    ],
  );

  if (!open) return null;

  const fetchBusy = sourceControl.busyAction === "fetch";
  const pullBusy = sourceControl.busyAction === "pull";

  return (
    <TooltipProvider delayDuration={800} skipDelayDuration={300}>
      <aside className="flex h-full min-w-0 flex-col bg-card/80 backdrop-blur [contain:layout_style]">
        <header className="flex shrink-0 items-center justify-between gap-1.5 border-b border-border/55 px-2.5 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-[9.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/85">
              Source Control
            </span>
            <span className="text-muted-foreground/30">·</span>
            <div className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/55 bg-background/70 px-1.5 py-0.5 text-[11px] font-medium leading-none text-foreground">
              <HugeiconsIcon
                icon={GitBranchIcon}
                size={10}
                strokeWidth={2}
                className="shrink-0 text-muted-foreground"
              />
              <span className="max-w-[110px] truncate">{repoLabel}</span>
            </div>
            {scm.status && (scm.status.ahead > 0 || scm.status.behind > 0) ? (
              <div className="flex shrink-0 items-center gap-1 text-[10px] font-medium tabular-nums leading-none text-muted-foreground">
                {scm.status.ahead > 0 ? (
                  <span className="inline-flex items-center gap-0.5 rounded bg-muted/55 px-1 py-0.5">
                    <HugeiconsIcon
                      icon={ArrowUp01Icon}
                      size={9}
                      strokeWidth={2.2}
                    />
                    {scm.status.ahead}
                  </span>
                ) : null}
                {scm.status.behind > 0 ? (
                  <span className="inline-flex items-center gap-0.5 rounded bg-muted/55 px-1 py-0.5">
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      size={9}
                      strokeWidth={2.2}
                    />
                    {scm.status.behind}
                  </span>
                ) : null}
              </div>
            ) : null}
            {scm.status?.isDetached ? (
              <span className="rounded bg-muted/55 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                detached
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconActionButton
              label={fetchBusy ? "Fetching…" : "Fetch from remote"}
              disabled={!canFetch}
              onClick={handleFetch}
              side="bottom"
            >
              {fetchBusy ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon icon={CloudIcon} size={13} strokeWidth={1.9} />
              )}
            </IconActionButton>
            <IconActionButton
              label={
                pullBusy
                  ? "Pulling…"
                  : isDiverged
                    ? "Branch diverged — resolve in terminal"
                    : !hasUpstream
                      ? "No upstream configured"
                      : (scm.status?.behind ?? 0) === 0
                        ? "Already up to date"
                        : `Pull ${scm.status?.behind ?? 0} commits (fast-forward)`
              }
              disabled={!canPull}
              onClick={handlePull}
              side="bottom"
            >
              {pullBusy ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={13}
                  strokeWidth={2.1}
                />
              )}
            </IconActionButton>
            <IconActionButton
              label="Refresh source control"
              disabled={isRefreshing || !!scm.actionBusy}
              onClick={handleRefresh}
              side="bottom"
            >
              {isRefreshing ? (
                <Spinner className="size-3.5" />
              ) : (
                <HugeiconsIcon
                  icon={Refresh01Icon}
                  size={13}
                  strokeWidth={2}
                  className={cn(refreshAnimating && "animate-spin")}
                />
              )}
            </IconActionButton>
          </div>
        </header>

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
          <>
            <div className="relative shrink-0 space-y-2 border-b border-border/40 bg-card/55 px-2.5 pb-2 pt-2.5">
              <div className="relative">
                <Textarea
                  value={scm.commitMessage}
                  onChange={(event) => scm.setCommitMessage(event.target.value)}
                  onKeyDown={handleCommitShortcut}
                  placeholder={`Message  (${commitShortcut} to commit)`}
                  rows={3}
                  className={cn(
                    "min-h-[64px] resize-none rounded-md border border-border/55 bg-background/95 py-2 pl-2.5 pr-9 text-[12.5px] leading-snug shadow-none placeholder:text-muted-foreground/75 focus-visible:border-border/80 focus-visible:ring-0",
                  )}
                />
                <div className="absolute right-1.5 top-1.5">
                  <IconActionButton
                    label={`${scm.generateCommitMessageHint} (${generateShortcut})`}
                    disabled={!scm.canGenerateCommitMessage}
                    side="left"
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
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      canCommit ? "bg-emerald-500" : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="truncate">
                    {stagedCount === 0
                      ? "No staged changes"
                      : `${stagedCount} ${stagedCount === 1 ? "file" : "files"} staged`}
                  </span>
                </div>
                <span className="shrink-0 truncate text-muted-foreground/75">
                  {pushStatusLabel}
                </span>
              </div>

              <div className="flex w-full gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      className="h-7 flex-1 cursor-pointer text-[11.5px] font-medium disabled:cursor-not-allowed"
                      disabled={!canCommit}
                      onClick={() => void scm.commit()}
                    >
                      {scm.actionBusy === "commit" ? "Committing…" : "Commit"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn(SOURCE_CONTROL_TOOLTIP_CLASS, "text-[10.5px]")}
                  >
                    {commitHint}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-7 flex-1 cursor-pointer text-[11.5px] font-medium disabled:cursor-not-allowed"
                      disabled={!scm.canPush || !!scm.actionBusy}
                      onClick={() => void scm.push()}
                    >
                      {scm.actionBusy === "push" ? "Pushing…" : "Push"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn(
                      SOURCE_CONTROL_TOOLTIP_CLASS,
                      "max-w-64 text-[10.5px]",
                    )}
                  >
                    {pushDisabledReason}
                  </TooltipContent>
                </Tooltip>
              </div>

              <CommitFeedback feedback={footerFeedback} />
            </div>

            {scm.allClean ? <CleanTreeHint repoLabel={repoLabel} /> : null}

            <div
              ref={containerRef}
              tabIndex={0}
              role="listbox"
              aria-label="Changed files"
              aria-activedescendant={
                focusedRowKey ? `scm-row-${focusedRowKey}` : undefined
              }
              onKeyDown={handlePanelKeyDown}
              className="relative min-h-0 flex-1 outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
            >
              <div
                ref={scrollRef}
                className="h-full overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
              >
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    position: "relative",
                    width: "100%",
                  }}
                >
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const row = rows[virtualRow.index];
                    if (!row) return null;
                    return (
                      <div
                        key={virtualRow.key}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: virtualRow.size,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <RowRenderer
                          row={row}
                          focused={focusedRowKey === row.key}
                          selected={scm.selected}
                          actionBusy={scm.actionBusy}
                          stagedOpen={stagedOpen}
                          unstagedOpen={unstagedOpen}
                          setStagedOpen={setStagedOpen}
                          setUnstagedOpen={setUnstagedOpen}
                          onFocusRow={setFocusedRowKey}
                          onStageAll={scm.stageAllEntries}
                          onUnstageAll={scm.unstageAllEntries}
                          onDiscardAll={scm.requestDiscardAll}
                          onSelectEntry={scm.selectEntry}
                          onStageEntry={scm.stageEntry}
                          onUnstageEntry={scm.unstageEntry}
                          onDiscardEntry={scm.requestDiscardEntry}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <HistoryFooter
              ahead={scm.status.ahead}
              behind={scm.status.behind}
              upstream={scm.status.upstream}
              onOpenHistory={onOpenHistory}
            />
          </>
        ) : null}
      </aside>

      <AlertDialog
        open={scm.pendingDiscard !== null}
        onOpenChange={(o) => {
          if (!o) scm.cancelPendingDiscard();
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

function CleanTreeHint({ repoLabel }: { repoLabel: string }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5 px-4 py-4 text-center">
      <div className="flex size-8 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
        <HugeiconsIcon
          icon={CheckmarkCircle01Icon}
          size={16}
          strokeWidth={1.75}
        />
      </div>
      <div className="text-[11.5px] font-medium">Working tree clean</div>
      <div className="text-[10.5px] leading-snug text-muted-foreground">
        on <span className="font-mono text-foreground/80">{repoLabel}</span>
      </div>
    </div>
  );
}

function HistoryFooter({
  ahead,
  behind,
  upstream,
  onOpenHistory,
}: {
  ahead: number;
  behind: number;
  upstream: string | null;
  onOpenHistory?: () => void;
}) {
  const summary = useMemo(() => {
    const parts: string[] = [];
    if (ahead > 0) parts.push(`${ahead} ahead`);
    if (behind > 0) parts.push(`${behind} behind`);
    if (parts.length === 0) {
      return upstream
        ? `In sync with ${upstream}`
        : "Local branch · no upstream";
    }
    return parts.join(" · ");
  }, [ahead, behind, upstream]);

  return (
    <div className="shrink-0 border-t border-border/45 bg-card/65 px-2.5 py-2">
      <button
        type="button"
        onClick={onOpenHistory}
        disabled={!onOpenHistory}
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded-md border border-border/45 bg-background/55 px-2 py-1.5 text-left transition-colors",
          onOpenHistory
            ? "cursor-pointer hover:border-border/75 hover:bg-background/80"
            : "cursor-not-allowed opacity-75",
        )}
      >
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-muted-foreground group-hover:bg-foreground/8 group-hover:text-foreground">
          <HugeiconsIcon icon={Clock01Icon} size={13} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] font-medium leading-tight text-foreground">
            Open Git History
          </div>
          <div className="truncate text-[10px] leading-tight text-muted-foreground">
            {onOpenHistory ? summary : "Coming next — design in progress"}
          </div>
        </div>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className="shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5"
        />
      </button>
    </div>
  );
}

type RowRendererProps = {
  row: RowDescriptor;
  focused: boolean;
  selected: { path: string; mode: "+" | "-" } | null;
  actionBusy: string | null;
  stagedOpen: boolean;
  unstagedOpen: boolean;
  setStagedOpen: (open: boolean) => void;
  setUnstagedOpen: (open: boolean) => void;
  onFocusRow: (key: string | null) => void;
  onStageAll: () => Promise<void> | void;
  onUnstageAll: () => Promise<void> | void;
  onDiscardAll: () => void;
  onSelectEntry: (entry: SourceControlEntry) => Promise<void>;
  onStageEntry: (entry: SourceControlEntry) => Promise<void>;
  onUnstageEntry: (entry: SourceControlEntry) => Promise<void>;
  onDiscardEntry: (entry: SourceControlEntry) => void;
};

const RowRenderer = memo(function RowRenderer(props: RowRendererProps) {
  const { row } = props;
  switch (row.kind) {
    case "banner-diverged":
      return <DivergedBanner />;
    case "group-header":
      return <GroupHeader {...props} row={row} />;
    case "entry":
      return <EntryRow {...props} row={row} />;
    case "empty":
      return (
        <div className="px-3 pt-0.5 text-[11px] text-muted-foreground/80">
          {row.text}
        </div>
      );
  }
});

function DivergedBanner() {
  return (
    <div className="mx-2 mt-1 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-700 dark:text-amber-200">
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
  );
}

function GroupHeader({
  row,
  stagedOpen,
  unstagedOpen,
  setStagedOpen,
  setUnstagedOpen,
  actionBusy,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
}: RowRendererProps & {
  row: Extract<RowDescriptor, { kind: "group-header" }>;
}) {
  const isOpen = row.group === "staged" ? stagedOpen : unstagedOpen;
  const toggle = () => {
    if (row.group === "staged") setStagedOpen(!stagedOpen);
    else setUnstagedOpen(!unstagedOpen);
  };
  const title = row.group === "staged" ? "Staged" : "Changes";

  return (
    <div className="flex h-7 items-center gap-1.5 px-2">
      <button
        type="button"
        onClick={toggle}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left text-muted-foreground transition-colors hover:bg-accent/35 hover:text-foreground"
        aria-expanded={isOpen}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2.15}
          className={cn(
            "shrink-0 transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.14em]">
          {title}
        </span>
        <span className="rounded-sm bg-muted/55 px-1 py-px text-[9.5px] font-medium tabular-nums text-muted-foreground/85">
          {row.count}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        {row.group === "unstaged" ? (
          <>
            <IconActionButton
              label="Discard all changes"
              disabled={actionBusy !== null || row.count === 0}
              onClick={() => onDiscardAll()}
            >
              {actionBusy === "discard:all" ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon
                  icon={ArrowReloadHorizontalIcon}
                  size={11}
                  strokeWidth={2}
                />
              )}
            </IconActionButton>
            <IconActionButton
              label="Stage all"
              disabled={actionBusy !== null || row.count === 0}
              onClick={() => void onStageAll()}
            >
              {actionBusy === "stage:all" ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={2} />
              )}
            </IconActionButton>
          </>
        ) : (
          <IconActionButton
            label="Unstage all"
            disabled={actionBusy !== null || row.count === 0}
            onClick={() => void onUnstageAll()}
          >
            {actionBusy === "unstage:all" ? (
              <Spinner className="size-3" />
            ) : (
              <HugeiconsIcon icon={MinusSignIcon} size={11} strokeWidth={2} />
            )}
          </IconActionButton>
        )}
      </div>
    </div>
  );
}

const EntryRow = memo(function EntryRow({
  row,
  focused,
  selected,
  actionBusy,
  onFocusRow,
  onSelectEntry,
  onStageEntry,
  onUnstageEntry,
  onDiscardEntry,
}: RowRendererProps & {
  row: Extract<RowDescriptor, { kind: "entry" }>;
}) {
  const entry = row.entry;
  const isSelected =
    !!selected && selected.path === entry.path && selected.mode === entry.mode;
  const fileName = basename(entry.path);
  const iconUrl = fileIconUrl(fileName);
  const pathLabel = entryPathLabel(entry);
  const actionType = row.group === "staged" ? "unstage" : "stage";
  const actionIcon = actionType === "stage" ? PlusSignIcon : MinusSignIcon;
  const actionLabel = actionType === "stage" ? "Stage" : "Unstage";
  const onAction =
    actionType === "stage"
      ? () => void onStageEntry(entry)
      : () => void onUnstageEntry(entry);
  const showDiscard = row.group === "unstaged";
  const isBusy = actionBusy === `${actionType}:${entry.path}`;
  const isDiscardBusy = actionBusy === `discard:${entry.path}`;
  const disabled = actionBusy !== null;

  return (
    <div
      id={`scm-row-${row.key}`}
      data-focused={focused || undefined}
      data-selected={isSelected || undefined}
      role="option"
      aria-selected={isSelected}
      onMouseDown={() => onFocusRow(row.key)}
      className={cn(
        "group flex h-[30px] items-center gap-2 rounded-md border border-transparent px-2 transition-colors",
        focused
          ? "border-primary/35 bg-accent/55"
          : isSelected
            ? "bg-accent/65 text-foreground"
            : "hover:bg-accent/35",
      )}
    >
      <button
        type="button"
        onClick={() => {
          onFocusRow(row.key);
          void onSelectEntry(entry);
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
      >
        {iconUrl ? (
          <img src={iconUrl} alt="" className="size-4 shrink-0" />
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
          <span
            className={cn(
              "truncate text-[12px] font-medium leading-tight",
              pathLabel ? "max-w-[58%] shrink-0" : "min-w-0 flex-1",
            )}
          >
            {fileName}
          </span>
          {pathLabel ? (
            <span className="min-w-0 flex-1 truncate text-[10.5px] leading-tight text-muted-foreground/85">
              {pathLabel}
            </span>
          ) : null}
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 data-[focused=true]:opacity-100 data-[selected=true]:opacity-100">
        {showDiscard ? (
          <IconActionButton
            label={`Discard ${entry.path}`}
            disabled={disabled}
            side="top"
            onClick={() => onDiscardEntry(entry)}
          >
            {isDiscardBusy ? (
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
          label={`${actionLabel} ${entry.path}`}
          disabled={disabled}
          side="top"
          onClick={onAction}
        >
          {isBusy ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon icon={actionIcon} size={11} strokeWidth={2} />
          )}
        </IconActionButton>
      </div>

      <span
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded text-[9.5px] font-bold leading-none tabular-nums",
          statusTone(entry.statusCode),
        )}
        title={entry.statusLabel}
      >
        {entry.statusCode}
      </span>
    </div>
  );
});

function IconActionButton({
  label,
  disabled,
  side = "left",
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  side?: "left" | "top" | "right" | "bottom";
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
        "pointer-events-none absolute inset-x-3 top-[calc(100%-0.25rem)] z-20 flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg shadow-black/15 backdrop-blur transition-all duration-200",
        isVisible
          ? "translate-y-0 opacity-100"
          : "-translate-y-1 opacity-0",
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
