import { cn } from "@/lib/utils";
import { useSidebarDeckStore } from "@/modules/sidebar";
import {
  Activity01Icon,
  Delete02Icon,
  File02Icon,
  HardDriveIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { CleanupHub } from "./components/CleanupHub";
import { ComposeCard } from "./components/ComposeCard";
import { ContainerRow } from "./components/ContainerRow";
import { DetailsDrawer } from "./components/DetailsDrawer";
import { SwarmInitPrompt } from "./components/SwarmInitPrompt";
import { SwarmPanel } from "./components/SwarmPanel";
import { SwarmSecretsPanel } from "./components/SwarmSecretsPanel";
import { DockerEventsPane } from "./DockerEventsPane";
import { DockerLogsPane } from "./DockerLogsPane";
import { DockerConfirmDialog } from "./dialogs/DockerConfirmDialog";
import { ExecDialog } from "./dialogs/ExecDialog";
import { PullDialog } from "./dialogs/PullDialog";
import { RegistryDialog } from "./dialogs/RegistryDialog";
import { daemonLabel } from "./lib/capabilities";
import { composeProjectName, projectInFolder } from "./lib/compose";
import { containerId, containerName, containerState } from "./lib/container";
import { confirmDockerAction } from "./lib/dockerConfirmStore";
import { useDockerStore } from "./lib/dockerStore";
import type { DockerContainer, DockerResourceKind } from "./lib/types";

type OpenLogsTabFn = (input: {
  targetKind: "container" | "service";
  targetId: string;
  title?: string;
}) => number;

type OpenExecTabFn = (input: {
  hostId: string;
  container: string;
  containerName?: string;
  shell: string;
  attach?: boolean;
}) => number;

type Props = {
  /** Active tab's host id (null = local/WSL: v1 shows an empty state). */
  hostId: string | null;
  hostAlias?: string | null;
  /** Active explorer root (remote path when hostId is set). Drives the
   *  "in this folder" compose section — a compose file whose directory
   *  matches (or is an ancestor/descendant of) this path surfaces first. */
  cwd?: string | null;
  openLogsTabRef?: React.MutableRefObject<OpenLogsTabFn | null>;
  openExecTabRef?: React.MutableRefObject<OpenExecTabFn | null>;
  /** False while spaces/tabs are still restoring from disk. `hostId` is
   *  momentarily null during that window even when the eventual active
   *  tab is an SSH host — suppress the "host-scoped" empty state until
   *  boot resolves so it doesn't flash on every app launch. */
  booted?: boolean;
};

const SEGMENTS: {
  id: DockerResourceKind | "compose" | "swarm";
  label: string;
}[] = [
  { id: "containers", label: "Containers" },
  { id: "images", label: "Images" },
  { id: "compose", label: "Compose" },
  { id: "swarm", label: "Swarm" },
  { id: "volumes", label: "Volumes" },
  { id: "networks", label: "Networks" },
];

export function DockerPanel({
  hostId,
  hostAlias,
  cwd,
  openLogsTabRef,
  openExecTabRef,
  booted = true,
}: Props) {
  const [segment, setSegment] = useState<
    DockerResourceKind | "compose" | "swarm"
  >("containers");
  // Detail surface lives in the shared sidebar deck store: App.tsx renders
  // it in a real ResizablePanel next to the list, so it never stacks or
  // covers this panel's own content.
  const setDeck = useSidebarDeckStore((s) => s.openCard);
  const closeDeck = useSidebarDeckStore((s) => s.closeCard);
  const [filter, setFilter] = useState("");
  const [pullReference, setPullReference] = useState("");
  const [activePulls, setActivePulls] = useState<string[]>([]);
  // Detail openers: each replaces the current card (single focus). The
  // bodies live below so the openers stay one-liners at the call sites.
  const openInspectDeck = (target: {
    kind: "container" | "volume" | "network";
    id: string;
    title: string;
  }) => {
    if (!hostId) return;
    const t = target;
    const h = hostId;
    setDeck({
      key: `inspect-${t.kind}-${t.id}`,
      title: t.title,
      badge: t.kind,
      body: <DetailsDrawerBody hostId={h} target={t} />,
    });
  };
  const openLogsDeck = (target: {
    kind: "container";
    id: string;
    title: string;
  }) => {
    if (!hostId) return;
    const t = target;
    const h = hostId;
    setDeck({
      key: `logs-${t.id}`,
      title: `Logs · ${t.title}`,
      body: <LogsDeckBody hostId={h} kind={t.kind} id={t.id} title={t.title} />,
    });
  };
  const openServiceLogsDeck = (target: {
    serviceId: string;
    title: string;
  }) => {
    if (!hostId) return;
    const t = target;
    const h = hostId;
    setDeck({
      key: `service-logs-${t.serviceId}`,
      title: `Logs · ${t.title}`,
      body: (
        <LogsDeckBody
          hostId={h}
          kind="service"
          id={t.serviceId}
          title={t.title}
        />
      ),
    });
  };
  const openEventsDeck = () => {
    if (!hostId) return;
    const h = hostId;
    setDeck({
      key: "events",
      title: "Events",
      body: <EventsDeckBody hostId={h} />,
    });
  };
  const openCleanupDeck = () => {
    if (!hostId) return;
    const h = hostId;
    setDeck({
      key: "cleanup",
      title: "Disk usage & cleanup",
      body: <CleanupDeckBody hostId={h} />,
    });
  };
  const openPullPromptDeck = () => {
    setDeck({
      key: "pull-prompt",
      title: "Pull image",
      narrow: true,
      body: (
        <PullPromptBody
          reference={pullReference}
          onChange={setPullReference}
          onSubmit={() => openPull(pullReference)}
          onClose={() => {
            setPullReference("");
            closeDeck();
          }}
        />
      ),
    });
  };
  const openRegistryDeck = () => {
    if (!hostId) return;
    const h = hostId;
    setDeck({
      key: "registry",
      title: "Registry login",
      narrow: true,
      body: <RegistryDeckBody hostId={h} />,
    });
  };
  const openExecDeck = (target: {
    container: string;
    containerName: string;
  }) => {
    if (!hostId) return;
    const t = target;
    const h = hostId;
    setDeck({
      key: `exec-${t.container}`,
      title: `Exec in ${t.containerName}`,
      narrow: true,
      body: (
        <ExecDeckBody
          hostId={h}
          container={t.container}
          containerName={t.containerName}
          onExec={(shell, attach) =>
            openExec(t.container, t.containerName, shell, attach)
          }
          onClose={closeDeck}
        />
      ),
    });
  };
  const openPullProgressDeck = (jobId: string) => {
    if (!hostId) return;
    const h = hostId;
    setDeck({
      key: `pull-${jobId}`,
      title: "Pull image",
      body: (
        <PullProgressDeckBody
          hostId={h}
          jobId={jobId}
          onClose={() =>
            setActivePulls((ids) => ids.filter((j) => j !== jobId))
          }
        />
      ),
    });
  };
  const startPull = useDockerStore((s) => s.startPull);
  const openLogsTab = (
    targetKind: "container" | "service",
    targetId: string,
    title: string,
  ) => {
    openLogsTabRef?.current?.({ targetKind, targetId, title });
  };
  const openExec = (
    container: string,
    containerName: string,
    shell: string,
    attach: boolean,
  ) => {
    if (!hostId) return;
    openExecTabRef?.current?.({
      hostId,
      container,
      containerName,
      shell,
      attach,
    });
    closeDeck();
  };

  const openPull = (reference: string) => {
    const ref = reference.trim();
    if (!ref || !hostId) {
      openPullPromptDeck();
      return;
    }
    const jobId = startPull(hostId, ref);
    setActivePulls((ids) => [...ids, jobId]);
    setPullReference("");
    openPullProgressDeck(jobId);
  };

  const hostState = useDockerStore((s) =>
    hostId ? (s.byHost[hostId] ?? null) : null,
  );
  const refreshAll = useDockerStore((s) => s.refreshAll);
  const refreshStats = useDockerStore((s) => s.refreshStats);
  const [statsOn, setStatsOn] = useState(false);

  useEffect(() => {
    if (hostId) void refreshAll(hostId);
  }, [hostId, refreshAll]);

  // Close any open detail card when this panel unmounts (switching to a
  // different sidebar view or losing the SSH host): the shared deck panel
  // must not keep showing a Docker card once Docker is no longer active.
  useEffect(() => {
    return () => {
      closeDeck();
    };
    // Unmount-only cleanup; closeDeck is a stable zustand action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stats poll while the containers segment is visible and toggled on.
  // 5s cadence; only running containers are sampled.
  const runningIds = useMemo(() => {
    if (!statsOn) return [];
    return (hostState?.containers.items ?? [])
      .filter((c) => containerState(c) === "running")
      .map((c) => containerId(c));
  }, [statsOn, hostState?.containers.items]);

  useEffect(() => {
    if (!hostId || runningIds.length === 0) return;
    void refreshStats(hostId, runningIds);
    const t = setInterval(() => {
      void refreshStats(hostId, runningIds);
    }, 5000);
    return () => clearInterval(t);
  }, [hostId, runningIds, refreshStats]);

  const daemon = hostState?.daemon ?? { status: "unknown" as const };
  const containers = hostState?.containers;

  const filteredContainers = useMemo(() => {
    if (!hostId) return [];
    const items = containers?.items ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) =>
      [containerId(c), containerName(c), c.Image, c.Status]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [hostId, containers?.items, filter]);

  // Compose project grouping from container labels
  // (com.docker.compose.project + .config_files), refreshed when the
  // container list changes. Projects with no live containers still show
  // if the store already knows their files.
  const refreshCompose = useDockerStore((s) => s.refreshCompose);

  const containersById = useMemo(() => {
    const out: Record<string, DockerContainer> = {};
    for (const c of containers?.items ?? []) out[containerId(c)] = c;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containers?.items]);

  useEffect(() => {
    if (!hostId || !containers?.items) return;
    const groups = groupComposeProjects(containers.items);
    for (const [name, g] of Object.entries(groups)) {
      void refreshCompose(hostId, name, g.files, g.projectDir).catch(() => {});
    }
    // Grouping derives from the container list; refresh per list change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, containers?.updatedAt]);

  // Shared row handlers: the containers list and compose service rows both
  // need the same "open logs/inspect/exec for this container" behavior.
  const containerHandlers = (c: DockerContainer) => {
    const id = containerId(c);
    return {
      onInspect: () =>
        openInspectDeck({ kind: "container", id, title: containerName(c) }),
      onLogs: () =>
        openLogsDeck({ kind: "container", id, title: containerName(c) }),
      onLogsTab: () =>
        openLogsTab("container", id, `${containerName(c)} logs`),
      onExec: () =>
        openExecDeck({ container: id, containerName: containerName(c) }),
    };
  };

  if (!hostId) {
    // While spaces/tabs are still restoring, hostId is transiently null
    // even when the tab about to become active is an SSH host — render
    // just the title (no "host-scoped" message) so switching to the
    // Docker view right after launch doesn't flash it before the real
    // host resolves.
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelTitle title="Docker" />
        {booted ? (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
            Docker is host-scoped in v1. Open an SSH tab to browse its
            containers.
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PanelTitle
        title="Docker"
        subtitle={hostAlias ?? hostId}
        right={
          <span className="flex items-center gap-1">
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {daemonLabel(daemon)}
            </span>
            <HeaderButton label="Docker events" onClick={openEventsDeck}>
              <HugeiconsIcon
                icon={Activity01Icon}
                size={13}
                strokeWidth={1.75}
              />
            </HeaderButton>
            <HeaderButton
              label="Disk usage & cleanup"
              onClick={openCleanupDeck}
            >
              <HugeiconsIcon
                icon={HardDriveIcon}
                size={13}
                strokeWidth={1.75}
              />
            </HeaderButton>
            <HeaderButton
              label="Refresh Docker"
              onClick={() => void refreshAll(hostId)}
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                size={13}
                strokeWidth={1.75}
              />
            </HeaderButton>
          </span>
        }
      />
      {daemon.status === "ready" ? (
        <>
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 pb-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {SEGMENTS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSegment(s.id)}
                aria-pressed={segment === s.id}
                className={cn(
                  "shrink-0 rounded-md px-2 py-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
                  segment === s.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s.label}
                {s.id === "containers" &&
                (containers?.items.length ?? 0) > 0 ? (
                  <span className="ml-1 text-[10px] text-muted-foreground/70">
                    {containers?.items.length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 px-2 pb-1.5">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${segment}`}
              className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
            />
            {segment === "containers" ? (
              <button
                type="button"
                onClick={() => setStatsOn((v) => !v)}
                aria-pressed={statsOn}
                title={statsOn ? "Hide live stats" : "Show live stats"}
                className={cn(
                  "h-7 shrink-0 rounded-md px-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
                  statsOn
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Stats
              </button>
            ) : null}
            {segment === "images" ? (
              <>
                <button
                  type="button"
                  onClick={openRegistryDeck}
                  title="Registry login"
                  className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Registry
                </button>
                <button
                  type="button"
                  onClick={openPullPromptDeck}
                  title="Pull image"
                  className="h-7 shrink-0 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Pull
                </button>
              </>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {segment === "containers" ? (
              containers?.loading && filteredContainers.length === 0 ? (
                <EmptyNote text="Loading containers…" />
              ) : containers?.error && filteredContainers.length === 0 ? (
                <EmptyNote text={containers.error} />
              ) : statsOn && hostState?.statsError ? (
                <EmptyNote
                  text={`Stats unavailable: ${hostState.statsError}. Retrying…`}
                />
              ) : filteredContainers.length === 0 ? (
                <EmptyNote
                  text={
                    filter
                      ? "No containers match the filter."
                      : "No containers on this host."
                  }
                />
              ) : (
                filteredContainers.map((c) => {
                  const id = containerId(c);
                  return (
                    <ContainerRow
                      key={id}
                      hostId={hostId}
                      container={c}
                      hostAlias={hostAlias}
                      stats={statsOn ? hostState?.stats[id] ?? null : null}
                      {...containerHandlers(c)}
                    />
                  );
                })
              )
            ) : segment === "images" ? (
              <ImagesList
                hostId={hostId}
                hostAlias={hostAlias}
                filter={filter}
                onPull={openPullPromptDeck}
                onRegistry={openRegistryDeck}
                activePulls={activePulls}
              />
            ) : segment === "compose" ? (
              <ComposeList
                hostId={hostId}
                cwd={cwd ?? null}
                filter={filter}
                containersById={containersById}
                statsById={statsOn ? (hostState?.stats ?? {}) : {}}
                hostAlias={hostAlias}
                containerHandlers={containerHandlers}
              />
            ) : segment === "swarm" ? (
              <SwarmView
                hostId={hostId}
                capabilities={
                  daemon.status === "ready" ? daemon.capabilities : null
                }
                onOpenServiceLogs={(serviceId, title) =>
                  openServiceLogsDeck({ serviceId, title })
                }
              />
            ) : segment === "volumes" ? (
              <VolumesList
                hostId={hostId}
                hostAlias={hostAlias}
                filter={filter}
                onInspect={(kind, id, title) =>
                  openInspectDeck({ kind, id, title })
                }
              />
            ) : (
              <NetworksList
                hostId={hostId}
                hostAlias={hostAlias}
                filter={filter}
                onInspect={(kind, id, title) =>
                  openInspectDeck({ kind, id, title })
                }
              />
            )}
          </div>
        </>
      ) : daemon.status === "checking" || daemon.status === "unknown" ? (
        <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
          Checking Docker…
        </div>
      ) : (
        <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
          {daemonLabel(daemon)}
          {"message" in daemon && daemon.message ? (
            <div className="mt-1 break-words text-[10px]">{daemon.message}</div>
          ) : null}
        </div>
      )}
      <DockerConfirmDialog />
    </div>
  );
}

/** Group containers into compose projects via labels. */
function groupComposeProjects(
  items: DockerContainer[],
): Record<string, { files: string[]; projectDir: string }> {
  const out: Record<string, { files: string[]; projectDir: string }> = {};
  for (const c of items) {
    const labels = parseLabels(c.Labels);
    const project = labels["com.docker.compose.project"];
    if (!project) continue;
    const filesRaw = labels["com.docker.compose.project.config_files"] ?? "";
    const files = filesRaw
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    const dir = labels["com.docker.compose.project.working_dir"] ?? "";
    if (!out[project]) out[project] = { files, projectDir: dir };
    else {
      for (const f of files) {
        if (!out[project].files.includes(f)) out[project].files.push(f);
      }
      if (!out[project].projectDir && dir) out[project].projectDir = dir;
    }
  }
  return out;
}

function parseLabels(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "string") return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

type ContainerHandlers = (c: DockerContainer) => {
  onInspect: () => void;
  onLogs: () => void;
  onLogsTab: () => void;
  onExec: () => void;
};

function ComposeList({
  hostId,
  cwd,
  filter,
  containersById,
  statsById,
  hostAlias,
  containerHandlers,
}: {
  hostId: string;
  cwd: string | null;
  filter: string;
  containersById: Record<string, DockerContainer>;
  statsById: Record<string, import("./lib/dockerStore").StatsSample>;
  hostAlias?: string | null;
  containerHandlers: ContainerHandlers;
}) {
  const projects = useDockerStore((s) => s.byHost[hostId]?.compose ?? {});
  const detectCompose = useDockerStore((s) => s.detectCompose);
  const refreshCompose = useDockerStore((s) => s.refreshCompose);
  const [cwdFiles, setCwdFiles] = useState<string[] | null>(null);

  // Detect compose files sitting directly in the active folder. This is the
  // "you're standing in a compose project" case: it must work even when the
  // project has never been started (so no container labels exist to group).
  useEffect(() => {
    let cancelled = false;
    setCwdFiles(null);
    if (!cwd) return;
    detectCompose(hostId, cwd).then(
      (files) => {
        if (!cancelled) setCwdFiles(files);
      },
      () => {
        if (!cancelled) setCwdFiles([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [hostId, cwd, detectCompose]);

  const all = useMemo(() => Object.values(projects), [projects]);

  // Projects whose files live in the active folder (or a subfolder). A
  // running project's working_dir is the authoritative match; fall back to
  // comparing the file's dirname.
  const inFolder = useMemo(
    () => all.filter((p) => projectInFolder(p, cwd)),
    [all, cwd],
  );

  // Register a detected-but-never-started project so its card has a stable
  // store entry (container list, profiles, actions all key off the store).
  useEffect(() => {
    if (!cwd || !cwdFiles || cwdFiles.length === 0) return;
    const dir = cwd.replace(/\/+$/, "");
    const already = inFolder.some(
      (p) => p.projectDir.replace(/\/+$/, "") === dir,
    );
    if (already) return;
    const name = composeProjectName(dir);
    void refreshCompose(hostId, name, cwdFiles, cwd).catch(() => {});
    // Only re-register when the detected set or folder changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, cwd, cwdFiles?.join("|"), inFolder.length]);

  const q = filter.trim().toLowerCase();
  const matches = (p: { name: string; files: string[] }) =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    p.files.some((f) => f.toLowerCase().includes(q));

  const folderList = inFolder.filter(matches);
  const restList = all.filter((p) => !inFolder.includes(p)).filter(matches);

  const cwdProject = folderList[0];
  const otherFolderProjects = folderList.slice(1);

  if (all.length === 0 && (!cwdFiles || cwdFiles.length === 0)) {
    return (
      <EmptyNote
        text={
          filter
            ? "No compose projects match the filter."
            : "No compose projects detected — run containers with a compose file to see them here."
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {cwdProject ? (
        <section className="flex flex-col gap-1">
          <SectionHeading
            title="In this folder"
            hint={cwd ?? undefined}
          />
          <ComposeCard
            key={cwdProject.name}
            hostId={hostId}
            hostAlias={hostAlias}
            project={cwdProject}
            containersById={containersById}
            statsById={statsById}
            containerHandlers={containerHandlers}
            availableFiles={
              cwdFiles && cwdFiles.length > 0
                ? cwdFiles
                : cwdProject.files
            }
          />
          {otherFolderProjects.map((p) => (
            <ComposeCard
              key={p.name}
              hostId={hostId}
              hostAlias={hostAlias}
              project={p}
              containersById={containersById}
              statsById={statsById}
              containerHandlers={containerHandlers}
            />
          ))}
        </section>
      ) : null}

      {restList.length > 0 ? (
        <section className="flex flex-col gap-1">
          {all.length > folderList.length ? (
            <SectionHeading
              title={folderList.length > 0 ? "All projects" : "Compose"}
              count={restList.length}
            />
          ) : null}
          {restList.map((p) => (
            <ComposeCard
              key={p.name}
              hostId={hostId}
              hostAlias={hostAlias}
              project={p}
              containersById={containersById}
              statsById={statsById}
              containerHandlers={containerHandlers}
            />
          ))}
        </section>
      ) : null}

      {folderList.length === 0 && restList.length === 0 ? (
        <EmptyNote text="No compose projects match the filter." />
      ) : null}
    </div>
  );
}

function SectionHeading({
  title,
  count,
  hint,
}: {
  title: string;
  count?: number;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5 px-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        {title}
      </span>
      {count !== undefined ? (
        <span className="text-[10px] tabular-nums text-muted-foreground/50">
          {count}
        </span>
      ) : null}
      {hint ? (
        <span
          className="min-w-0 flex-1 truncate text-right font-mono text-[9px] text-muted-foreground/40"
          title={hint}
        >
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function SwarmView({
  hostId,
  capabilities,
  onOpenServiceLogs,
}: {
  hostId: string;
  capabilities: { swarmState: string } | null;
  onOpenServiceLogs: (serviceId: string, title: string) => void;
}) {
  const swarmActive =
    (capabilities?.swarmState ?? "").toLowerCase() === "active";
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [initOpen, setInitOpen] = useState(false);
  if (!swarmActive) {
    return (
      <div className="flex flex-col gap-1.5 px-1.5 pb-2">
        <EmptyNote text="Swarm is inactive on this host — services, nodes and stacks need an initialized swarm." />
        <button
          type="button"
          onClick={() => setInitOpen(true)}
          className="mx-auto rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
        >
          Initialize or join swarm…
        </button>
        {initOpen ? (
          <SwarmInitPrompt hostId={hostId} onClose={() => setInitOpen(false)} />
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <SwarmPanel
        hostId={hostId}
        swarmActive
        onOpenServiceLogs={onOpenServiceLogs}
      />
      <div className="px-1.5 pb-2">
        <button
          type="button"
          onClick={() => setSecretsOpen((v) => !v)}
          aria-expanded={secretsOpen}
          className="w-full rounded-md border border-border/40 px-2 py-1 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          {secretsOpen ? "▾" : "▸"} Secrets & configs
        </button>
        {secretsOpen ? (
          <div className="mt-1">
            <SwarmSecretsPanel hostId={hostId} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Deck bodies: thin wrappers that render a legacy overlay component in
 *  `bare` mode (body only, no frame/header) as one deck CARD BODY. The
 *  deck panel owns the shared header + close for all of them. */
function DetailsDrawerBody({
  hostId,
  target,
}: {
  hostId: string;
  target: {
    kind: "container" | "volume" | "network";
    id: string;
    title: string;
  };
}) {
  return (
    <DetailsDrawer hostId={hostId} target={target} onClose={() => {}} bare />
  );
}

function LogsDeckBody({
  hostId,
  kind,
  id,
  title,
}: {
  hostId: string;
  kind: "container" | "service";
  id: string;
  title: string;
}) {
  return (
    <DockerLogsPane
      hostId={hostId}
      kind={kind}
      id={id}
      title={title}
      onClose={() => {}}
      bare
    />
  );
}

function EventsDeckBody({ hostId }: { hostId: string }) {
  return <DockerEventsPane hostId={hostId} onClose={() => {}} bare />;
}

function CleanupDeckBody({ hostId }: { hostId: string }) {
  return <CleanupHub hostId={hostId} onClose={() => {}} bare />;
}

function RegistryDeckBody({ hostId }: { hostId: string }) {
  return <RegistryDialog hostId={hostId} onClose={() => {}} bare />;
}

function ExecDeckBody({
  hostId,
  container,
  containerName,
  onExec,
  onClose,
}: {
  hostId: string;
  container: string;
  containerName: string;
  onExec: (shell: string, attach: boolean) => void;
  onClose: () => void;
}) {
  return (
    <ExecDialog
      hostId={hostId}
      container={container}
      containerName={containerName}
      onExec={onExec}
      onClose={onClose}
      bare
    />
  );
}

function PullProgressDeckBody({
  hostId,
  jobId,
  onClose,
}: {
  hostId: string;
  jobId: string;
  onClose: () => void;
}) {
  return <PullDialog hostId={hostId} jobId={jobId} onClose={onClose} bare />;
}

function PullPromptBody({
  reference,
  onChange,
  onSubmit,
  onClose,
}: {
  reference: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col" role="dialog" aria-label="Pull image">
      <div className="flex flex-col gap-2 px-2.5 py-2">
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-medium text-muted-foreground">
            Image reference
          </span>
          <input
            value={reference}
            onChange={(e) => onChange(e.target.value)}
            placeholder="nginx:latest"
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
              if (e.key === "Escape") onClose();
            }}
            className="h-7 rounded-md border border-border/60 bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
          />
        </label>
        <div className="text-[10px] text-muted-foreground/70">
          Pulled on the remote host. Progress streams live; the images list
          refreshes when it finishes.
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-border/60 px-2.5 py-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!reference.trim()}
          onClick={onSubmit}
          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          Pull
        </button>
      </div>
    </div>
  );
}

function ImagesList({
  hostId,
  hostAlias,
  filter,
  onPull,
  onRegistry,
  activePulls,
}: {
  hostId: string;
  hostAlias?: string | null;
  filter: string;
  onPull: () => void;
  onRegistry: () => void;
  activePulls: string[];
}) {
  const images = useDockerStore((s) => s.byHost[hostId]?.images);
  const busyImages = useDockerStore((s) => s.byHost[hostId]?.busyImages ?? {});
  const updates = useDockerStore((s) => s.byHost[hostId]?.updates ?? {});
  const removeImage = useDockerStore((s) => s.removeImage);
  const checkUpdate = useDockerStore((s) => s.checkUpdate);
  const startPull = useDockerStore((s) => s.startPull);

  const filtered = useMemo(() => {
    const items = images?.items ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((img) =>
      [imageRef(img), img.ID, img.Id, img.Size]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [images?.items, filter]);

  if (images?.loading && filtered.length === 0) {
    return <EmptyNote text="Loading images…" />;
  }
  if (images?.error && filtered.length === 0) {
    return <EmptyNote text={images.error} />;
  }
  if (filtered.length === 0 && activePulls.length === 0) {
    return (
      <EmptyNote
        text={
          filter ? "No images match the filter." : "No images on this host."
        }
      />
    );
  }
  return (
    <>
      {filtered.map((img) => {
        const id = imageId(img);
        const ref = imageRef(img);
        const update = updates[ref];
        return (
          <div
            key={id + ref}
            className="group relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent/50"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[12px] font-medium leading-tight">
                {ref}
                {update?.status === "available" ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void (async () => {
                        const confirmed = await confirmDockerAction({
                          title: "Pull image update",
                          actionLabel: "Pull update",
                          actionVariant: "default",
                          resourceKind: "Image",
                          resourceName: ref,
                          hostAlias: hostAlias ?? hostId,
                          description:
                            "Pulls the newer image digest for this tag from the registry.",
                        });
                        if (!confirmed) return;
                        const jobId = startPull(hostId, ref);
                        void jobId;
                      })();
                    }}
                    title="Update available — pull now"
                    className="ml-1.5 rounded bg-amber-500/15 px-1 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-500/25"
                  >
                    update
                  </button>
                ) : null}
                {busyImages[id] ? (
                  <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/70">
                    removing…
                  </span>
                ) : null}
              </span>
              <span className="truncate text-[10px] leading-tight text-muted-foreground/60">
                {`${String(img.Size ?? "")} · ${id.slice(0, 12)}${update?.status === "checking" ? " · checking updates…" : ""}`}
              </span>
            </span>
            <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
              <RowButton
                label={`Check for updates to ${ref}`}
                onClick={() => void checkUpdate(hostId, ref)}
              >
                <HugeiconsIcon
                  icon={Refresh01Icon}
                  size={13}
                  strokeWidth={1.75}
                />
              </RowButton>
              <RowButton
                label={`Remove image ${ref}`}
                onClick={() => {
                  void (async () => {
                    const confirmed = await confirmDockerAction({
                      title: "Remove image",
                      actionLabel: "Remove",
                      actionVariant: "destructive",
                      resourceKind: "Image",
                      resourceName: ref,
                      resourceDetails: `ID: ${id.slice(0, 12)} · Size: ${String(img.Size ?? "")}`,
                      hostAlias: hostAlias ?? hostId,
                      description:
                        "Removes this image from the remote host. Any containers referencing this image should be stopped or removed first.",
                    });
                    if (!confirmed) return;
                    void removeImage(hostId, id, true);
                  })();
                }}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  size={13}
                  strokeWidth={1.75}
                />
              </RowButton>
            </span>
          </div>
        );
      })}
      {activePulls.length > 0 ? (
        <div className="px-2 pt-1 text-[10px] text-muted-foreground/70">
          {activePulls.length} pull{activePulls.length === 1 ? "" : "s"} in
          progress — see panels on the right.
        </div>
      ) : null}
      <div className="flex gap-1.5 px-2 pt-2">
        <button
          type="button"
          onClick={onPull}
          className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Pull image…
        </button>
        <button
          type="button"
          onClick={onRegistry}
          className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Registry login…
        </button>
      </div>
    </>
  );
}

function VolumesList({
  hostId,
  hostAlias,
  filter,
  onInspect,
}: {
  hostId: string;
  hostAlias?: string | null;
  filter: string;
  onInspect: (kind: "volume", id: string, title: string) => void;
}) {
  const volumes = useDockerStore((s) => s.byHost[hostId]?.volumes);
  const removeVolume = useDockerStore((s) => s.removeVolume);

  const filtered = useMemo(() => {
    const items = volumes?.items ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((v) =>
      [v.Name, v.Driver, v.Mountpoint, v.Scope]
        .filter(Boolean)
        .some((x) => String(x).toLowerCase().includes(q)),
    );
  }, [volumes?.items, filter]);

  if (volumes?.loading && filtered.length === 0) {
    return <EmptyNote text="Loading volumes…" />;
  }
  if (volumes?.error && filtered.length === 0) {
    return <EmptyNote text={volumes.error} />;
  }
  if (filtered.length === 0) {
    return (
      <EmptyNote
        text={
          filter ? "No volumes match the filter." : "No volumes on this host."
        }
      />
    );
  }
  return (
    <>
      {filtered.map((v) => {
        const name = String(v.Name ?? "?");
        return (
          <div
            key={name}
            className="group relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent/50"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[12px] font-medium leading-tight">
                {name}
              </span>
              <span className="truncate text-[10px] leading-tight text-muted-foreground/60">
                {`${String(v.Driver ?? "")} · ${String(v.Scope ?? "")}`}
              </span>
            </span>
            <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
              <RowButton
                label={`Inspect volume ${name}`}
                onClick={() => onInspect("volume", name, name)}
              >
                <HugeiconsIcon
                  icon={File02Icon}
                  size={13}
                  strokeWidth={1.75}
                />
              </RowButton>
              <RowButton
                label={`Remove volume ${name}`}
                onClick={() => {
                  void (async () => {
                    const confirmed = await confirmDockerAction({
                      title: "Remove volume",
                      actionLabel: "Remove",
                      actionVariant: "destructive",
                      resourceKind: "Volume",
                      resourceName: name,
                      resourceDetails: `${String(v.Driver ?? "")} · ${String(v.Scope ?? "")}`,
                      hostAlias: hostAlias ?? hostId,
                      description:
                        "Permanently deletes this Docker volume and all stored data from the host.",
                    });
                    if (!confirmed) return;
                    void removeVolume(hostId, name);
                  })();
                }}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  size={13}
                  strokeWidth={1.75}
                />
              </RowButton>
            </span>
          </div>
        );
      })}
    </>
  );
}

function NetworksList({
  hostId,
  hostAlias,
  filter,
  onInspect,
}: {
  hostId: string;
  hostAlias?: string | null;
  filter: string;
  onInspect: (kind: "network", id: string, title: string) => void;
}) {
  const networks = useDockerStore((s) => s.byHost[hostId]?.networks);
  const removeNetwork = useDockerStore((s) => s.removeNetwork);

  const filtered = useMemo(() => {
    const items = networks?.items ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((n) =>
      [n.Name, n.Driver, n.Scope, n.ID ?? n.Id]
        .filter(Boolean)
        .some((x) => String(x).toLowerCase().includes(q)),
    );
  }, [networks?.items, filter]);

  if (networks?.loading && filtered.length === 0) {
    return <EmptyNote text="Loading networks…" />;
  }
  if (networks?.error && filtered.length === 0) {
    return <EmptyNote text={networks.error} />;
  }
  if (filtered.length === 0) {
    return (
      <EmptyNote
        text={
          filter ? "No networks match the filter." : "No networks on this host."
        }
      />
    );
  }
  const isBuiltin = (name: string) =>
    name === "bridge" || name === "host" || name === "none";
  return (
    <>
      {filtered.map((n) => {
        const name = String(n.Name ?? "?");
        const builtin = isBuiltin(name);
        const netId = String(n.ID ?? n.Id ?? "");
        return (
          <div
            key={String(n.ID ?? n.Id ?? name)}
            className="group relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent/50"
          >
            <span
              role="img"
              aria-label={n.Driver ? String(n.Driver) : "network"}
              className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[12px] font-medium leading-tight">
                {name}
              </span>
              <span className="truncate text-[10px] leading-tight text-muted-foreground/60">
                {`${String(n.Driver ?? "")} · ${String(n.Scope ?? "")}`}
              </span>
            </span>
            {builtin ? (
              <span className="shrink-0 rounded bg-accent px-1 py-px text-[10px] text-muted-foreground/70">
                builtin
              </span>
            ) : (
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <RowButton
                  label={`Inspect network ${name}`}
                  onClick={() => onInspect("network", name, name)}
                >
                  <HugeiconsIcon
                    icon={File02Icon}
                    size={13}
                    strokeWidth={1.75}
                  />
                </RowButton>
                <RowButton
                  label={`Remove network ${name}`}
                  onClick={() => {
                    void (async () => {
                      const confirmed = await confirmDockerAction({
                        title: "Remove network",
                        actionLabel: "Remove",
                        actionVariant: "destructive",
                        resourceKind: "Network",
                        resourceName: name,
                        resourceDetails: netId
                          ? `ID: ${netId.slice(0, 12)} · ${String(n.Driver ?? "")}`
                          : undefined,
                        hostAlias: hostAlias ?? hostId,
                        description:
                          "Deletes this network. Connected containers will lose connectivity.",
                      });
                      if (!confirmed) return;
                      void removeNetwork(hostId, name);
                    })();
                  }}
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    size={13}
                    strokeWidth={1.75}
                  />
                </RowButton>
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

function imageId(img: {
  ID?: string;
  Id?: string;
  [key: string]: unknown;
}): string {
  const raw = String(img.ID ?? img.Id ?? "?");
  return raw.replace(/^sha256:/, "").slice(0, 12);
}

function imageRef(img: {
  Repository?: string;
  Tag?: string;
  Digest?: string;
  [key: string]: unknown;
}): string {
  const repo = String(img.Repository ?? "<none>");
  const tag = String(img.Tag ?? "<none>");
  if (repo === "<none>" && tag === "<none>")
    return String(img.Digest ?? imageId(img));
  return `${repo}:${tag}`;
}

function PanelTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string | null;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between px-2.5 pb-1.5 pt-2">
      <span className="flex min-w-0 items-baseline gap-1.5 text-xs font-semibold text-foreground">
        {title}
        {subtitle ? (
          <span className="truncate text-[10px] font-normal text-muted-foreground/70">
            {subtitle}
          </span>
        ) : null}
      </span>
      {right}
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
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
      className="flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function EmptyNote({ text }: { text: string }) {
  return (
    <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
      {text}
    </div>
  );
}
