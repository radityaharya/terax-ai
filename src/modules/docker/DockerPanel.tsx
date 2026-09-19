import { cn } from "@/lib/utils";
import {
  RotateClockwiseIcon,
  Activity01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  ComputerTerminal02Icon,
  Delete02Icon,
  File02Icon,
  HardDriveIcon,
  PlayIcon,
  StopIcon,
  Refresh01Icon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { CleanupHub } from "./components/CleanupHub";
import { ComposeCard } from "./components/ComposeCard";
import { SwarmInitPrompt } from "./components/SwarmInitPrompt";
import { SwarmPanel } from "./components/SwarmPanel";
import { SwarmSecretsPanel } from "./components/SwarmSecretsPanel";
import { DetailsDrawer } from "./components/DetailsDrawer";
import { DockerEventsPane } from "./DockerEventsPane";
import { DockerLogsPane } from "./DockerLogsPane";
import { ExecDialog } from "./dialogs/ExecDialog";
import { PullDialog } from "./dialogs/PullDialog";
import { RegistryDialog } from "./dialogs/RegistryDialog";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { daemonLabel } from "./lib/capabilities";
import {
  useDockerStore,
  type ContainerAction,
} from "./lib/dockerStore";
import type {
  DockerContainer,
  DockerResourceKind,
} from "./lib/types";

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
  openLogsTabRef?: React.MutableRefObject<OpenLogsTabFn | null>;
  openExecTabRef?: React.MutableRefObject<OpenExecTabFn | null>;
};

const SEGMENTS: { id: DockerResourceKind | "compose" | "swarm"; label: string }[] = [
  { id: "containers", label: "Containers" },
  { id: "images", label: "Images" },
  { id: "compose", label: "Compose" },
  { id: "swarm", label: "Swarm" },
  { id: "volumes", label: "Volumes" },
  { id: "networks", label: "Networks" },
];

export function DockerPanel({ hostId, hostAlias, openLogsTabRef, openExecTabRef }: Props) {
  const [segment, setSegment] = useState<DockerResourceKind | "compose" | "swarm">("containers");
  const [execTarget, setExecTarget] = useState<{
    container: string;
    containerName: string;
  } | null>(null);
  const [filter, setFilter] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<{
    kind: "container" | "volume" | "network";
    id: string;
    title: string;
  } | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);
  const [pullReference, setPullReference] = useState("");
  const [registryOpen, setRegistryOpen] = useState(false);
  const [activePulls, setActivePulls] = useState<string[]>([]);
  const [logsTarget, setLogsTarget] = useState<{
    kind: "container";
    id: string;
    title: string;
  } | null>(null);
  const [serviceLogsTarget, setServiceLogsTarget] = useState<{
    serviceId: string;
    title: string;
  } | null>(null);
  const startPull = useDockerStore((s) => s.startPull);
  const openLogsTab = (targetKind: "container" | "service", targetId: string, title: string) => {
    openLogsTabRef?.current?.({ targetKind, targetId, title });
  };
  const openExec = (container: string, containerName: string, shell: string, attach: boolean) => {
    if (!hostId) return;
    openExecTabRef?.current?.({ hostId, container, containerName, shell, attach });
    setExecTarget(null);
  };

  const openPull = (reference: string) => {
    const ref = reference.trim();
    if (!ref || !hostId) {
      setPullOpen(true);
      return;
    }
    const jobId = startPull(hostId, ref);
    setActivePulls((ids) => [...ids, jobId]);
    setPullOpen(false);
    setPullReference("");
  };

  const hostState = useDockerStore((s) =>
    hostId ? (s.byHost[hostId] ?? null) : null,
  );
  const refreshAll = useDockerStore((s) => s.refreshAll);
  const containerAction = useDockerStore((s) => s.containerAction);
  const refreshStats = useDockerStore((s) => s.refreshStats);
  const [statsOn, setStatsOn] = useState(false);

  useEffect(() => {
    if (hostId) void refreshAll(hostId);
  }, [hostId, refreshAll]);

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
  const busy = hostState?.busyContainers ?? {};

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

  const containerNamesById = useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of containers?.items ?? []) {
      out[containerId(c)] = containerName(c);
    }
    return out;
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

  const runAction = (action: ContainerAction, id: string) => {
    if (!hostId) return;
    if (action === "remove" && confirmRemove !== id) {
      setConfirmRemove(id);
      return;
    }
    setConfirmRemove(null);
    void containerAction(hostId, action, [id], { force: true });
  };

  if (!hostId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelTitle title="Docker" />
        <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
          Docker is host-scoped in v1. Open an SSH tab to browse its containers.
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {inspecting ? (
        <DetailsDrawer
          hostId={hostId}
          target={inspecting}
          onClose={() => setInspecting(null)}
        />
      ) : null}
      {cleanupOpen ? (
        <CleanupHub hostId={hostId} onClose={() => setCleanupOpen(false)} />
      ) : null}
      {eventsOpen ? (
        <DockerEventsPane hostId={hostId} onClose={() => setEventsOpen(false)} />
      ) : null}
      {logsTarget ? (
        <DockerLogsPane
          hostId={hostId}
          kind={logsTarget.kind}
          id={logsTarget.id}
          title={logsTarget.title}
          onClose={() => setLogsTarget(null)}
        />
      ) : null}
      {serviceLogsTarget ? (
        <DockerLogsPane
          hostId={hostId}
          kind="service"
          id={serviceLogsTarget.serviceId}
          title={serviceLogsTarget.title}
          onClose={() => setServiceLogsTarget(null)}
        />
      ) : null}
      {activePulls.map((jobId) => (
        <PullDialog
          key={jobId}
          hostId={hostId}
          jobId={jobId}
          onClose={() =>
            setActivePulls((ids) => ids.filter((j) => j !== jobId))
          }
        />
      ))}
      {pullOpen ? (
        <PullPrompt
          reference={pullReference}
          onChange={setPullReference}
          onSubmit={() => openPull(pullReference)}
          onClose={() => {
            setPullOpen(false);
            setPullReference("");
          }}
        />
      ) : null}
      {registryOpen ? (
        <RegistryDialog hostId={hostId} onClose={() => setRegistryOpen(false)} />
      ) : null}
      {execTarget ? (
        <ExecDialog
          hostId={hostId}
          container={execTarget.container}
          containerName={execTarget.containerName}
          onExec={(shell, attach) => openExec(execTarget.container, execTarget.containerName, shell, attach)}
          onClose={() => setExecTarget(null)}
        />
      ) : null}
      <PanelTitle
        title="Docker"
        subtitle={hostAlias ?? hostId}
        right={
          <span className="flex items-center gap-1">
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {daemonLabel(daemon)}
            </span>
            <HeaderButton
              label="Docker events"
              onClick={() => setEventsOpen(true)}
            >
              <HugeiconsIcon icon={Activity01Icon} size={13} strokeWidth={1.75} />
            </HeaderButton>
            <HeaderButton
              label="Disk usage & cleanup"
              onClick={() => setCleanupOpen(true)}
            >
              <HugeiconsIcon icon={HardDriveIcon} size={13} strokeWidth={1.75} />
            </HeaderButton>
            <HeaderButton
              label="Refresh Docker"
              onClick={() => void refreshAll(hostId)}
            >
              <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
            </HeaderButton>
          </span>
        }
      />
      {daemon.status === "ready" ? (
        <>
          <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
            {SEGMENTS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSegment(s.id)}
                aria-pressed={segment === s.id}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
                  segment === s.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s.label}
                {s.id === "containers" && (containers?.items.length ?? 0) > 0 ? (
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
                title={statsOn ? "Hide live stats" : "Show live CPU/memory stats"}
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
                  onClick={() => setRegistryOpen(true)}
                  title="Registry login"
                  className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Registry
                </button>
                <button
                  type="button"
                  onClick={() => setPullOpen(true)}
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
              ) : filteredContainers.length === 0 ? (
                <EmptyNote
                  text={filter ? "No containers match the filter." : "No containers on this host."}
                />
              ) : (
                filteredContainers.map((c) => {
                  const id = containerId(c);
                  const busyAction = busy[id];
                  const sample = hostState?.stats[id];
                  return (
                    <ContainerRow
                      key={id}
                      container={c}
                      busy={busyAction}
                      confirmingRemove={confirmRemove === id}
                      onAction={(a) => runAction(a, id)}
                      onCancelRemove={() => setConfirmRemove(null)}
                      onInspect={() =>
                        setInspecting({
                          kind: "container",
                          id,
                          title: containerName(c),
                        })
                      }
                      onLogs={() =>
                        setLogsTarget({
                          kind: "container",
                          id,
                          title: containerName(c),
                        })
                      }
                      onLogsTab={() => openLogsTab("container", id, `${containerName(c)} logs`)}
                      onExec={() => setExecTarget({ container: id, containerName: containerName(c) })}
                      stats={
                        statsOn && sample
                          ? { cpuPerc: sample.cpuPerc, memUsage: sample.memUsage }
                          : null
                      }
                    />
                  );
                })
              )
            ) : segment === "images" ? (
              <ImagesList
                hostId={hostId}
                filter={filter}
                onPull={() => setPullOpen(true)}
                onRegistry={() => setRegistryOpen(true)}
                activePulls={activePulls}
              />
            ) : segment === "compose" ? (
              <ComposeList
                hostId={hostId}
                filter={filter}
                containerNames={containerNamesById}
                onOpenLogs={(id, title) =>
                  setLogsTarget({ kind: "container", id, title })
                }
              />
            ) : segment === "swarm" ? (
              <SwarmView
                hostId={hostId}
                capabilities={daemon.status === "ready" ? daemon.capabilities : null}
                onOpenServiceLogs={(serviceId, title) =>
                  setServiceLogsTarget({ serviceId, title })
                }
              />
            ) : segment === "volumes" ? (
              <VolumesList
                hostId={hostId}
                filter={filter}
                onInspect={(kind, id, title) => setInspecting({ kind, id, title })}
              />
            ) : (
              <NetworksList
                hostId={hostId}
                filter={filter}
                onInspect={(kind, id, title) => setInspecting({ kind, id, title })}
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
    </div>
  );
}

/** Group containers into compose projects via labels. */
function groupComposeProjects(items: DockerContainer[]): Record<
  string,
  { files: string[]; projectDir: string }
> {
  const out: Record<string, { files: string[]; projectDir: string }> = {};
  for (const c of items) {
    const labels = parseLabels(c.Labels);
    const project = labels["com.docker.compose.project"];
    if (!project) continue;
    const filesRaw = labels["com.docker.compose.project.config_files"] ?? "";
    const files = filesRaw.split(",").map((f) => f.trim()).filter(Boolean);
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

function ComposeList({
  hostId,
  filter,
  containerNames,
  onOpenLogs,
}: {
  hostId: string;
  filter: string;
  containerNames: Record<string, string>;
  onOpenLogs: (id: string, title: string) => void;
}) {
  const projects = useDockerStore((s) => s.byHost[hostId]?.compose ?? {});
  const list = useMemo(() => {
    const all = Object.values(projects);
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.files.some((f) => f.toLowerCase().includes(q)),
    );
  }, [projects, filter]);
  if (list.length === 0) {
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
    <>
      {list.map((p) => (
        <ComposeCard
          key={p.name}
          hostId={hostId}
          project={p}
          containerNames={containerNames}
          onOpenLogs={onOpenLogs}
        />
      ))}
    </>
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
  const swarmActive = (capabilities?.swarmState ?? "").toLowerCase() === "active";
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

function PullPrompt({
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
    <div
      className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l border-border/60 bg-background shadow-xl"
      role="dialog"
      aria-label="Pull image"
    >
      <div className="flex shrink-0 items-center px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          Pull image
        </span>
      </div>
      <div className="flex flex-col gap-2 px-2.5 py-2">
        <label className="flex flex-col gap-1 text-[11px]">
          <span className="font-medium text-muted-foreground">Image reference</span>
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
  filter,
  onPull,
  onRegistry,
  activePulls,
}: {
  hostId: string;
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
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

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
        text={filter ? "No images match the filter." : "No images on this host."}
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
                      const jobId = startPull(hostId, ref);
                      void jobId;
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
                {confirmRemove === id
                  ? `Remove ${ref}?`
                  : `${String(img.Size ?? "")} · ${id.slice(0, 12)}${update?.status === "checking" ? " · checking updates…" : ""}`}
              </span>
            </span>
            {confirmRemove === id ? (
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmRemove(null);
                    void removeImage(hostId, id, true);
                  }}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemove(null)}
                  className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
                >
                  Keep
                </button>
              </span>
            ) : (
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <RowButton
                  label={`Check for updates to ${ref}`}
                  onClick={() => void checkUpdate(hostId, ref)}
                >
                  <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
                </RowButton>
              </span>
            )}
          </div>
        );
      })}
      {activePulls.length > 0 ? (
        <div className="px-2 pt-1 text-[10px] text-muted-foreground/70">
          {activePulls.length} pull{activePulls.length === 1 ? "" : "s"} in progress — see panels on the right.
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
  filter,
  onInspect,
}: {
  hostId: string;
  filter: string;
  onInspect: (kind: "volume", id: string, title: string) => void;
}) {
  const volumes = useDockerStore((s) => s.byHost[hostId]?.volumes);
  const removeVolume = useDockerStore((s) => s.removeVolume);
  const [confirm, setConfirm] = useState<string | null>(null);

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
        text={filter ? "No volumes match the filter." : "No volumes on this host."}
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
              <span className="truncate text-[12px] font-medium leading-tight">{name}</span>
              <span className="truncate text-[10px] leading-tight text-muted-foreground/60">
                {confirm === name
                  ? `Remove volume ${name}? Data will be lost.`
                  : `${String(v.Driver ?? "")} · ${String(v.Scope ?? "")}`}
              </span>
            </span>
            {confirm === name ? (
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setConfirm(null);
                    void removeVolume(hostId, name);
                  }}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => setConfirm(null)}
                  className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
                >
                  Keep
                </button>
              </span>
            ) : (
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <RowButton
                  label={`Inspect volume ${name}`}
                  onClick={() => onInspect("volume", name, name)}
                >
                  <HugeiconsIcon icon={File02Icon} size={13} strokeWidth={1.75} />
                </RowButton>
                <RowButton label={`Remove volume ${name}`} onClick={() => setConfirm(name)}>
                  <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
                </RowButton>
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

function NetworksList({
  hostId,
  filter,
  onInspect,
}: {
  hostId: string;
  filter: string;
  onInspect: (kind: "network", id: string, title: string) => void;
}) {
  const networks = useDockerStore((s) => s.byHost[hostId]?.networks);
  const removeNetwork = useDockerStore((s) => s.removeNetwork);
  const [confirm, setConfirm] = useState<string | null>(null);

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
        text={filter ? "No networks match the filter." : "No networks on this host."}
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
              <span className="truncate text-[12px] font-medium leading-tight">{name}</span>
              <span className="truncate text-[10px] leading-tight text-muted-foreground/60">
                {confirm === name
                  ? `Remove network ${name}?`
                  : `${String(n.Driver ?? "")} · ${String(n.Scope ?? "")}`}
              </span>
            </span>
            {builtin ? (
              <span className="shrink-0 rounded bg-accent px-1 py-px text-[10px] text-muted-foreground/70">
                builtin
              </span>
            ) : confirm === name ? (
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setConfirm(null);
                    void removeNetwork(hostId, name);
                  }}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => setConfirm(null)}
                  className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
                >
                  Keep
                </button>
              </span>
            ) : (
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <RowButton
                  label={`Inspect network ${name}`}
                  onClick={() => onInspect("network", name, name)}
                >
                  <HugeiconsIcon icon={File02Icon} size={13} strokeWidth={1.75} />
                </RowButton>
                <RowButton label={`Remove network ${name}`} onClick={() => setConfirm(name)}>
                  <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
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
  if (repo === "<none>" && tag === "<none>") return String(img.Digest ?? imageId(img));
  return `${repo}:${tag}`;
}

export function containerId(c: DockerContainer): string {
  const raw = (c.ID ?? c.Id ?? "") as string;
  return raw.replace(/^sha256:/, "").slice(0, 12) || String(c.Names ?? c.Name ?? "?");
}

export function containerName(c: DockerContainer): string {
  const raw = String(c.Names ?? c.Name ?? "");
  return raw.split(",")[0]?.replace(/^\//, "").trim() || containerId(c);
}

function containerState(c: DockerContainer): "running" | "exited" | "paused" | "dead" | "unknown" {
  const s = String(c.State ?? "").toLowerCase();
  if (s.includes("running")) return "running";
  if (s.includes("paused")) return "paused";
  if (s.includes("dead") || s.includes("removing")) return "dead";
  if (s.includes("exited") || s.includes("created")) return "exited";
  // `docker ps --format json` emits State + Status ("Up 2 hours").
  const status = String(c.Status ?? "").toLowerCase();
  if (status.startsWith("up")) return "running";
  if (status.startsWith("exited") || status.startsWith("created")) return "exited";
  if (status.includes("paused")) return "paused";
  return "unknown";
}

const STATE_DOT: Record<string, string> = {
  running: "bg-emerald-500",
  exited: "bg-muted-foreground/40",
  paused: "bg-amber-400",
  dead: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

function ContainerRow({
  container,
  busy,
  confirmingRemove,
  onAction,
  onCancelRemove,
  onInspect,
  onLogs,
  onLogsTab,
  onExec,
  stats,
}: {
  container: DockerContainer;
  busy: ContainerAction | undefined;
  confirmingRemove: boolean;
  onAction: (a: ContainerAction) => void;
  onCancelRemove: () => void;
  onInspect: () => void;
  onLogs: () => void;
  onLogsTab: () => void;
  onExec: () => void;
  stats?: { cpuPerc: string; memUsage: string } | null;
}) {
  const id = containerId(container);
  const name = containerName(container);
  const state = containerState(container);
  const running = state === "running";
  const detail = String(container.Status ?? container.Image ?? "");
  const statsLine =
    stats && (stats.cpuPerc || stats.memUsage)
      ? `CPU ${stats.cpuPerc || "—"} · MEM ${stats.memUsage || "—"}`
      : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: row hosts nested buttons, cannot be a <button>
    <div
      role="button"
      tabIndex={0}
      title={`${name} (${id}) — click for details`}
      onClick={confirmingRemove ? undefined : onInspect}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !confirmingRemove) {
          e.preventDefault();
          onInspect();
        }
      }}
      className="group relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <span
        role="img"
        aria-label={state}
        title={state}
        className={cn("size-2 shrink-0 rounded-full", STATE_DOT[state])}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] font-medium leading-tight">
          {name}
          {busy ? (
            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/70">
              {busy === "remove" ? "removing…" : `${busy}ing…`}
            </span>
          ) : null}
        </span>
        <span className="truncate text-[10px] leading-tight text-muted-foreground/60">
          {confirmingRemove ? `Remove ${name}?` : detail}
        </span>
        {statsLine && !confirmingRemove ? (
          <span className="truncate text-[10px] tabular-nums leading-tight text-primary/80">
            {statsLine}
          </span>
        ) : null}
      </span>
      {confirmingRemove ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAction("remove");
            }}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10"
          >
            Remove
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancelRemove();
            }}
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
          >
            Keep
          </button>
        </span>
      ) : (
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {running ? (
            <>
              <RowButton label={`Stop ${name}`} onClick={() => onAction("stop")}>
                <HugeiconsIcon icon={StopIcon} size={13} strokeWidth={1.75} />
              </RowButton>
              <RowButton label={`Restart ${name}`} onClick={() => onAction("restart")}>
                <HugeiconsIcon icon={RotateClockwiseIcon} size={13} strokeWidth={1.75} />
              </RowButton>
              <RowButton label={`Kill ${name}`} onClick={() => onAction("kill")}>
                <HugeiconsIcon icon={ZapIcon} size={13} strokeWidth={1.75} />
              </RowButton>
            </>
          ) : (
            <RowButton label={`Start ${name}`} onClick={() => onAction("start")}>
              <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.75} />
            </RowButton>
          )}
          <RowButton label={`Logs for ${name}`} onClick={onLogs}>
            <HugeiconsIcon icon={File02Icon} size={13} strokeWidth={1.75} />
          </RowButton>
          <RowButton label={`Open logs for ${name} in a tab`} onClick={onLogsTab}>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={1.75} />
          </RowButton>
          {running ? (
            <RowButton label={`Exec shell in ${name}`} onClick={onExec}>
              <HugeiconsIcon icon={ComputerTerminal02Icon} size={13} strokeWidth={1.75} />
            </RowButton>
          ) : null}
          <RowButton label={`Remove ${name}`} onClick={() => onAction("remove")}>
            <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
          </RowButton>
          <RowButton label="Cancel" onClick={onCancelRemove}>
            <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
          </RowButton>
        </span>
      )}
    </div>
  );
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
