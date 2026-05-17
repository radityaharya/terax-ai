import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  native,
  type GitCommitFileChange,
  type GitDiffContentResult,
  type GitLogEntry,
} from "@/modules/ai/lib/native";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Cancel01Icon,
  Clock01Icon,
  Copy01Icon,
  GitBranchIcon,
  LinkSquare02Icon,
  Refresh01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  commitWebUrl,
  hostLabel,
  parseRemoteWebUrl,
  type RemoteWebInfo,
} from "./lib/remoteWebUrl";

const PAGE_SIZE = 30;
const ROW_HEIGHT = 54;
const NEAR_BOTTOM_PX = 240;
const FILES_CACHE_LIMIT = 16;
const FILE_DIFF_CACHE_LIMIT = 24;

type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  fallbackPatch: string;
};

type Props = {
  repoRoot: string;
  branch?: string | null;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
};

type LoadStatus = "idle" | "initial" | "more" | "error";

type FilesEntry =
  | { state: "loading" }
  | { state: "loaded"; files: GitCommitFileChange[] }
  | { state: "error"; error: string };

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

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown error";
}

function relativeTime(secs: number): string {
  if (!secs) return "";
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - secs);
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d`;
  if (delta < 86400 * 365) return `${Math.floor(delta / 86400 / 30)}mo`;
  return `${Math.floor(delta / 86400 / 365)}y`;
}

function absoluteTime(secs: number): string {
  if (!secs) return "";
  return new Date(secs * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(code: string): string {
  switch (code.toUpperCase()) {
    case "A":
      return "text-emerald-600 dark:text-emerald-400";
    case "M":
      return "text-amber-600 dark:text-amber-300";
    case "D":
      return "text-rose-600 dark:text-rose-400";
    case "R":
    case "C":
      return "text-sky-600 dark:text-sky-300";
    default:
      return "text-muted-foreground";
  }
}

function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-primary/25 px-0.5 text-foreground">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function GitHistoryPane({ repoRoot, branch, onOpenCommitFile }: Props) {
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [endReached, setEndReached] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const deferredSearch = useDeferredValue(searchInput.trim());
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [remoteWeb, setRemoteWeb] = useState<RemoteWebInfo | null>(null);

  const filesCacheRef = useRef(new Map<string, FilesEntry>());
  const fileDiffCacheRef = useRef(new Map<string, GitDiffContentResult>());
  const requestIdRef = useRef(0);
  const inflightMoreRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = deferredSearch.toLowerCase();
    if (!q) return commits;
    return commits.filter((c) => {
      const subject = c.subject.toLowerCase();
      const author = c.author.toLowerCase();
      const email = c.authorEmail.toLowerCase();
      return (
        subject.includes(q) ||
        author.includes(q) ||
        email.includes(q) ||
        c.shortSha.includes(q)
      );
    });
  }, [commits, deferredSearch]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
    getItemKey: (index) => filtered[index]?.sha ?? index,
  });

  const loadInitial = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadStatus("initial");
    setError(null);
    setEndReached(false);
    try {
      const entries = await native.gitLog(repoRoot, { limit: PAGE_SIZE });
      if (requestId !== requestIdRef.current) return;
      setCommits(entries);
      setLoadStatus("idle");
      if (entries.length < PAGE_SIZE) setEndReached(true);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(normalizeError(err));
      setLoadStatus("error");
    }
  }, [repoRoot]);

  const loadMore = useCallback(async () => {
    if (inflightMoreRef.current || endReached) return;
    if (loadStatus !== "idle") return;
    const last = commits[commits.length - 1];
    if (!last) return;
    inflightMoreRef.current = true;
    setLoadStatus("more");
    try {
      const entries = await native.gitLog(repoRoot, {
        limit: PAGE_SIZE,
        beforeSha: last.sha,
      });
      setCommits((prev) => {
        const seen = new Set(prev.map((c) => c.sha));
        const merged = [...prev];
        for (const e of entries) if (!seen.has(e.sha)) merged.push(e);
        return merged;
      });
      if (entries.length < PAGE_SIZE) setEndReached(true);
      setLoadStatus("idle");
    } catch (err) {
      setError(normalizeError(err));
      setLoadStatus("error");
    } finally {
      inflightMoreRef.current = false;
    }
  }, [commits, endReached, loadStatus, repoRoot]);

  useEffect(() => {
    filesCacheRef.current.clear();
    fileDiffCacheRef.current.clear();
    setCommits([]);
    setOpenSha(null);
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    let cancelled = false;
    native
      .gitRemoteUrl(repoRoot)
      .then((url) => {
        if (cancelled) return;
        setRemoteWeb(parseRemoteWebUrl(url));
      })
      .catch(() => {
        if (cancelled) return;
        setRemoteWeb(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (deferredSearch) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < NEAR_BOTTOM_PX) {
      void loadMore();
    }
  }, [deferredSearch, loadMore]);

  const handleRefresh = useCallback(() => {
    filesCacheRef.current.clear();
    fileDiffCacheRef.current.clear();
    void loadInitial();
  }, [loadInitial]);

  const ensureFilesLoaded = useCallback(
    async (sha: string) => {
      const cache = filesCacheRef.current;
      const existing = cache.get(sha);
      if (existing && existing.state !== "error") return;
      cache.set(sha, { state: "loading" });
      try {
        const files = await native.gitCommitFiles(repoRoot, sha);
        cache.set(sha, { state: "loaded", files });
        while (cache.size > FILES_CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      } catch (err) {
        cache.set(sha, { state: "error", error: normalizeError(err) });
      }
      setOpenSha((current) => (current === sha ? sha : current));
    },
    [repoRoot],
  );

  const handleOpenChange = useCallback(
    (sha: string, open: boolean) => {
      if (open) {
        setOpenSha(sha);
        void ensureFilesLoaded(sha);
      } else if (openSha === sha) {
        setOpenSha(null);
      }
    },
    [ensureFilesLoaded, openSha],
  );

  const handleFileOpen = useCallback(
    async (commit: GitLogEntry, file: GitCommitFileChange) => {
      const cacheKey = `${commit.sha}|${file.path}`;
      const cache = fileDiffCacheRef.current;
      let result = cache.get(cacheKey);
      if (!result) {
        try {
          result = await native.gitCommitFileDiff(
            repoRoot,
            commit.sha,
            file.path,
            file.originalPath,
          );
          cache.set(cacheKey, result);
          while (cache.size > FILE_DIFF_CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
        } catch (err) {
          setError(normalizeError(err));
          return;
        }
      }
      onOpenCommitFile({
        repoRoot,
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        path: file.path,
        originalPath: file.originalPath,
        originalContent: result.originalContent,
        modifiedContent: result.modifiedContent,
        isBinary: result.isBinary,
        fallbackPatch: result.fallbackPatch,
      });
      setOpenSha(null);
    },
    [onOpenCommitFile, repoRoot],
  );

  const copyToClipboard = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      /* noop */
    }
  }, []);

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={200}>
      <div className="flex h-full min-h-0 flex-col bg-background [contain:layout_style]">
        <header className="flex shrink-0 items-center gap-2 border-b border-border/55 bg-card/65 px-3 py-2 backdrop-blur">
          <div className="flex shrink-0 items-center gap-1.5">
            <HugeiconsIcon
              icon={Clock01Icon}
              size={14}
              strokeWidth={1.85}
              className="text-muted-foreground"
            />
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
              History
            </span>
            {branch ? (
              <div className="ml-1 inline-flex items-center gap-1 rounded-md border border-border/55 bg-background/70 px-1.5 py-0.5 text-[11px] font-medium leading-none text-foreground">
                <HugeiconsIcon
                  icon={GitBranchIcon}
                  size={10}
                  strokeWidth={2}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="max-w-[180px] truncate">{branch}</span>
              </div>
            ) : null}
          </div>

          <div className="relative ml-auto min-w-0 max-w-md flex-1">
            <HugeiconsIcon
              icon={Search01Icon}
              size={12}
              strokeWidth={1.9}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70"
            />
            <Input
              value={searchInput}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setSearchInput(event.target.value)
              }
              placeholder="Search subject, author, sha…"
              className="h-7 rounded-md border-border/55 bg-background/85 pl-7 pr-7 text-[12px] placeholder:text-muted-foreground/70 focus-visible:border-border/80 focus-visible:ring-0"
            />
            {searchInput ? (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 inline-flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground"
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  size={10}
                  strokeWidth={2}
                />
              </button>
            ) : null}
          </div>

          <div className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/75">
            {deferredSearch
              ? `${filtered.length} / ${commits.length}`
              : endReached
                ? `${commits.length}`
                : `${commits.length}+`}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh history"
                disabled={loadStatus === "initial"}
                onClick={handleRefresh}
                className="cursor-pointer rounded-md text-muted-foreground disabled:cursor-not-allowed"
              >
                {loadStatus === "initial" ? (
                  <Spinner className="size-3" />
                ) : (
                  <HugeiconsIcon
                    icon={Refresh01Icon}
                    size={13}
                    strokeWidth={2}
                  />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[10.5px]">
              Refresh
            </TooltipContent>
          </Tooltip>
        </header>

        {loadStatus === "initial" && commits.length === 0 ? (
          <CenterPlaceholder>
            <Spinner className="size-4" />
            <span className="text-[11.5px] text-muted-foreground">
              Loading commits…
            </span>
          </CenterPlaceholder>
        ) : loadStatus === "error" && commits.length === 0 ? (
          <CenterPlaceholder>
            <div className="text-[13px] font-medium">Could not load history</div>
            <div className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
              {error ?? "Unknown error"}
            </div>
            <Button size="sm" onClick={handleRefresh}>
              Retry
            </Button>
          </CenterPlaceholder>
        ) : commits.length === 0 ? (
          <CenterPlaceholder>
            <div className="text-[13px] font-medium">No commits yet</div>
            <div className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
              This branch has no commits.
            </div>
          </CenterPlaceholder>
        ) : (
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
          >
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
                width: "100%",
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const commit = filtered[virtualRow.index];
                if (!commit) return null;
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
                    <CommitRow
                      commit={commit}
                      query={deferredSearch}
                      open={openSha === commit.sha}
                      onOpenChange={handleOpenChange}
                      filesEntry={filesCacheRef.current.get(commit.sha) ?? null}
                      remoteWeb={remoteWeb}
                      onCopySha={copyToClipboard}
                      onOpenFile={handleFileOpen}
                    />
                  </div>
                );
              })}
            </div>

            {loadStatus === "more" ? (
              <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
                <Spinner className="size-3" />
                Loading more…
              </div>
            ) : null}
            {endReached && !deferredSearch ? (
              <div className="py-3 text-center text-[10.5px] text-muted-foreground/65">
                End of history
              </div>
            ) : null}
            {loadStatus === "error" && commits.length > 0 ? (
              <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-destructive">
                {error ?? "Failed to load more"}
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-6 cursor-pointer text-[11px]"
                  onClick={() => void loadMore()}
                >
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

function CenterPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      {children}
    </div>
  );
}

type CommitRowProps = {
  commit: GitLogEntry;
  query: string;
  open: boolean;
  onOpenChange: (sha: string, open: boolean) => void;
  filesEntry: FilesEntry | null;
  remoteWeb: RemoteWebInfo | null;
  onCopySha: (value: string) => Promise<void> | void;
  onOpenFile: (
    commit: GitLogEntry,
    file: GitCommitFileChange,
  ) => Promise<void> | void;
};

const CommitRow = memo(function CommitRow({
  commit,
  query,
  open,
  onOpenChange,
  filesEntry,
  remoteWeb,
  onCopySha,
  onOpenFile,
}: CommitRowProps) {
  const rel = relativeTime(commit.timestampSecs);
  const absolute = absoluteTime(commit.timestampSecs);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => onOpenChange(commit.sha, next)}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group flex h-full w-full cursor-pointer flex-col justify-center gap-1 border-l-2 border-transparent px-3 text-left transition-colors",
            open
              ? "border-l-primary/70 bg-accent/40"
              : "hover:bg-accent/25",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-muted/55 px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums text-muted-foreground">
              {commit.shortSha}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-tight text-foreground">
              {commit.subject ? (
                highlight(commit.subject, query)
              ) : (
                <span className="text-muted-foreground">(no subject)</span>
              )}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] leading-tight text-muted-foreground/85">
            <span className="truncate">
              {commit.author ? (
                highlight(commit.author, query)
              ) : (
                "Unknown"
              )}
            </span>
            <span className="text-muted-foreground/40">·</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 tabular-nums">{rel}</span>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-[10.5px]">
                {absolute}
              </TooltipContent>
            </Tooltip>
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        <CommitDetail
          commit={commit}
          filesEntry={filesEntry}
          remoteWeb={remoteWeb}
          onCopySha={onCopySha}
          onOpenFile={onOpenFile}
        />
      </PopoverContent>
    </Popover>
  );
});

type CommitDetailProps = {
  commit: GitLogEntry;
  filesEntry: FilesEntry | null;
  remoteWeb: RemoteWebInfo | null;
  onCopySha: (value: string) => Promise<void> | void;
  onOpenFile: (
    commit: GitLogEntry,
    file: GitCommitFileChange,
  ) => Promise<void> | void;
};

function CommitDetail({
  commit,
  filesEntry,
  remoteWeb,
  onCopySha,
  onOpenFile,
}: CommitDetailProps) {
  const absolute = absoluteTime(commit.timestampSecs);
  const webUrl = remoteWeb ? commitWebUrl(remoteWeb, commit.sha) : null;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1100);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <div className="flex flex-col">
      <div className="border-b border-border/45 p-3">
        <div className="flex items-start gap-2">
          <span className="mt-px shrink-0 rounded bg-muted/65 px-1.5 py-0.5 font-mono text-[10.5px] leading-none tabular-nums text-muted-foreground">
            {commit.shortSha}
          </span>
          <div className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-foreground">
            {commit.subject || (
              <span className="text-muted-foreground">(no subject)</span>
            )}
          </div>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="truncate">{commit.author || "Unknown"}</span>
          {commit.authorEmail ? (
            <>
              <span className="text-muted-foreground/45">·</span>
              <span className="truncate text-muted-foreground/85">
                {commit.authorEmail}
              </span>
            </>
          ) : null}
          <span className="text-muted-foreground/45">·</span>
          <span className="shrink-0 tabular-nums">{absolute}</span>
        </div>

        <div className="mt-2.5 flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            className="h-6 cursor-pointer gap-1.5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              void onCopySha(commit.sha);
              setCopied(true);
            }}
          >
            <HugeiconsIcon icon={Copy01Icon} size={11} strokeWidth={1.9} />
            {copied ? "Copied" : "Copy SHA"}
          </Button>
          {webUrl ? (
            <Button
              size="xs"
              variant="ghost"
              className="h-6 cursor-pointer gap-1.5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => void openUrl(webUrl).catch(console.error)}
            >
              <HugeiconsIcon
                icon={LinkSquare02Icon}
                size={11}
                strokeWidth={1.9}
              />
              {hostLabel(remoteWeb!)}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="max-h-[280px] overflow-hidden">
        <CommitFiles
          commit={commit}
          filesEntry={filesEntry}
          onOpenFile={onOpenFile}
        />
      </div>
    </div>
  );
}

function CommitFiles({
  commit,
  filesEntry,
  onOpenFile,
}: {
  commit: GitLogEntry;
  filesEntry: FilesEntry | null;
  onOpenFile: (
    commit: GitLogEntry,
    file: GitCommitFileChange,
  ) => Promise<void> | void;
}) {
  if (!filesEntry || filesEntry.state === "loading") {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
        <Spinner className="size-3" />
        Loading files…
      </div>
    );
  }
  if (filesEntry.state === "error") {
    return (
      <div className="px-3 py-3 text-[11px] text-destructive">
        {filesEntry.error}
      </div>
    );
  }
  if (filesEntry.files.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground">
        No file changes.
      </div>
    );
  }
  return (
    <>
      <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
        <span>Files</span>
        <span className="rounded-sm bg-muted/55 px-1 py-px text-[9.5px] tabular-nums text-muted-foreground/85 normal-case tracking-normal">
          {filesEntry.files.length}
        </span>
      </div>
      <ScrollArea className="max-h-[240px]">
        <ul className="space-y-px px-1.5 pb-2">
          {filesEntry.files.map((file) => (
            <li key={file.path}>
              <FileRow
                file={file}
                onOpen={() => void onOpenFile(commit, file)}
              />
            </li>
          ))}
        </ul>
      </ScrollArea>
    </>
  );
}

const FileRow = memo(function FileRow({
  file,
  onOpen,
}: {
  file: GitCommitFileChange;
  onOpen: () => void;
}) {
  const fileName = basename(file.path);
  const dir = dirname(file.path);
  const iconUrl = fileIconUrl(fileName);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-accent/40"
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="size-3.5 shrink-0" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
        <span className="truncate text-[11.5px] font-medium leading-tight">
          {fileName}
        </span>
        {dir ? (
          <span className="min-w-0 flex-1 truncate text-[10px] leading-tight text-muted-foreground/80">
            {dir}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
        {file.isBinary ? (
          <span className="text-muted-foreground/70">binary</span>
        ) : (
          <>
            {file.added > 0 ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                +{file.added}
              </span>
            ) : null}
            {file.removed > 0 ? (
              <span className="text-rose-600 dark:text-rose-400">
                −{file.removed}
              </span>
            ) : null}
          </>
        )}
      </div>
      <span
        className={cn(
          "inline-flex w-4 shrink-0 justify-center text-[9.5px] font-bold leading-none tabular-nums",
          statusTone(file.status),
        )}
        title={file.statusLabel}
      >
        {file.status.toUpperCase()}
      </span>
    </button>
  );
});
