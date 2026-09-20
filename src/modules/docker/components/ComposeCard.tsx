import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  PlayIcon,
  Refresh01Icon,
  StopIcon,
  Tag02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { confirmDockerAction } from "../lib/dockerConfirmStore";
import {
  useDockerStore,
  type ComposeProjectState,
  type StatsSample,
} from "../lib/dockerStore";
import type { DockerContainer } from "../lib/types";
import { ContainerRow } from "./ContainerRow";

type ContainerHandlers = (c: DockerContainer) => {
  onInspect: () => void;
  onLogs: () => void;
  onLogsTab: () => void;
  onExec: () => void;
};

type Props = {
  hostId: string;
  hostAlias?: string | null;
  project: ComposeProjectState;
  containersById: Record<string, DockerContainer>;
  statsById: Record<string, StatsSample>;
  containerHandlers: ContainerHandlers;
  /** Every compose file discovered in the project directory. When this is
   *  longer than one, the card exposes a multi-file picker so a folder with
   *  several compose files (or an override pair) can select what `-f` gets. */
  availableFiles?: string[];
};

/** Compose project card: per-service container rows with full lifecycle,
 *  multi-file selection, and profile opt-in. */
export function ComposeCard({
  hostId,
  hostAlias,
  project,
  containersById,
  statsById,
  containerHandlers,
  availableFiles,
}: Props) {
  const composeAction = useDockerStore((s) => s.composeAction);
  const setComposeProfiles = useDockerStore((s) => s.setComposeProfiles);
  const [filesOpen, setFilesOpen] = useState(false);
  // Selected file subset for `-f`. Defaults to every file the project was
  // registered with; the picker can narrow it.
  const [selectedFiles, setSelectedFiles] = useState<string[]>(project.files);
  const allFiles =
    availableFiles && availableFiles.length > 0 ? availableFiles : project.files;

  const profiles = project.profiles ?? [];
  const activeProfiles = project.activeProfiles;

  const toggleProfile = (name: string) => {
    const next = activeProfiles.includes(name)
      ? activeProfiles.filter((p) => p !== name)
      : [...activeProfiles, name];
    setComposeProfiles(hostId, project.name, next);
  };

  const toggleFile = (file: string) => {
    setSelectedFiles((prev) =>
      prev.includes(file) ? prev.filter((f) => f !== file) : [...prev, file],
    );
  };

  const run = async (
    action: "up" | "down" | "restart" | "pull",
    opts?: { build?: boolean; volumes?: boolean },
  ) => {
    const meta = {
      up: {
        title: "Start compose project",
        label: "Start",
        variant: "default" as const,
        desc: `Starts all service containers defined in ${project.name}.`,
      },
      restart: {
        title: "Restart compose project",
        label: "Restart",
        variant: "warning" as const,
        desc: `Restarts all running containers in ${project.name}.`,
      },
      pull: {
        title: "Pull compose images",
        label: "Pull",
        variant: "default" as const,
        desc: `Pulls updated images for all services in ${project.name}.`,
      },
      down: {
        title: "Stop compose project",
        label: "Stop",
        variant: "destructive" as const,
        desc: `Stops and removes all containers and networks created by ${project.name}.`,
      },
    }[action];

    // An empty selection would run compose with no -f and pick up whatever
    // cwd the agent happens to have. Never let that through.
    if (selectedFiles.length === 0) return;

    const profileNote =
      action !== "down" && activeProfiles.length > 0
        ? ` Profiles: ${activeProfiles.join(", ")}.`
        : "";

    const confirmed = await confirmDockerAction({
      title: meta.title,
      actionLabel: meta.label,
      actionVariant: meta.variant,
      resourceKind: "Compose Project",
      resourceName: project.name,
      resourceDetails: `${project.containers.length} container(s) · ${selectedFiles
        .map((f) => f.split("/").pop())
        .join(", ")}`,
      hostAlias: hostAlias ?? hostId,
      description: meta.desc + profileNote,
    });
    if (!confirmed) return;

    void composeAction(hostId, project.name, action, {
      ...opts,
      files: selectedFiles,
    });
  };

  const runningCount = project.containers.filter((id) => {
    const c = containersById[id];
    return c && String(c.State ?? "").toLowerCase().includes("running");
  }).length;

  return (
    <div className="rounded-md border border-border/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
          {project.name}
        </span>
        {profiles.length > 0 ? (
          <span
            className="shrink-0 rounded bg-accent/60 px-1 py-px text-[10px] tabular-nums text-muted-foreground"
            title={`Declared profiles: ${profiles.join(", ")}`}
          >
            {activeProfiles.length}/{profiles.length} profiles
          </span>
        ) : null}
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {runningCount}/{project.containers.length} up
        </span>
        {project.loading ? (
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            working…
          </span>
        ) : null}
      </div>

      <button
        type="button"
        disabled={allFiles.length <= 1}
        onClick={() => allFiles.length > 1 && setFilesOpen((v) => !v)}
        title={allFiles.join("\n")}
        className={cn(
          "mt-0.5 flex max-w-full items-center gap-1 text-left text-[10px] text-muted-foreground/60",
          allFiles.length > 1 && "hover:text-foreground",
        )}
      >
        <span className="truncate">
          {selectedFiles.length > 1
            ? `${selectedFiles.length} files`
            : (selectedFiles[0] ?? "—").split("/").pop()}
          {allFiles.length > 1 ? ` of ${allFiles.length}` : ""}
        </span>
      </button>

      {/* Multi-file picker: a folder can hold several compose files
          (compose.yml + override, or independent stacks under one project
          dir). Each toggles whether it is passed as `-f`. */}
      {filesOpen && allFiles.length > 1 ? (
        <div className="mt-1 flex flex-col gap-0.5 rounded bg-accent/40 p-1">
          {allFiles.map((f) => {
            const name = f.split("/").pop() ?? f;
            const on = selectedFiles.includes(f);
            return (
              <button
                key={f}
                type="button"
                onClick={() => toggleFile(f)}
                title={f}
                aria-pressed={on}
                className={cn(
                  "flex items-center gap-1 rounded px-1 py-0.5 text-left font-mono text-[10px]",
                  on ? "text-foreground" : "text-muted-foreground/50 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-[3px] border",
                    on ? "border-primary bg-primary" : "border-muted-foreground/40",
                  )}
                />
                <span className="truncate">{name}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {project.error ? (
        <div className="mt-0.5 break-words text-[10px] text-destructive">
          {project.error}
        </div>
      ) : null}

      {/* Profile opt-in: profile-gated services are off unless selected.
          Only offered once the file is known to declare profiles. */}
      {profiles.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <HugeiconsIcon
            icon={Tag02Icon}
            size={11}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground/60"
          />
          {profiles.map((p) => {
            const on = activeProfiles.includes(p);
            return (
              <button
                key={p}
                type="button"
                onClick={() => toggleProfile(p)}
                aria-pressed={on}
                title={on ? `Disable profile ${p}` : `Enable profile ${p}`}
                className={cn(
                  "rounded px-1.5 py-px text-[10px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
                  on
                    ? "bg-primary/15 text-primary"
                    : "bg-accent/50 text-muted-foreground hover:text-foreground",
                )}
              >
                {p}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Per-service rows: same lifecycle as the containers list. */}
      {project.containers.length > 0 ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {project.containers.map((id) => {
            const c = containersById[id];
            if (!c) {
              return (
                <div
                  key={id}
                  className="px-2 py-1 font-mono text-[10px] text-muted-foreground/50"
                >
                  {id.slice(0, 12)}
                </div>
              );
            }
            return (
              <ContainerRow
                key={id}
                hostId={hostId}
                container={c}
                hostAlias={hostAlias}
                stats={statsById[id] ?? null}
                {...containerHandlers(c)}
              />
            );
          })}
        </div>
      ) : (
        <div className="mt-1 px-1 text-[10px] text-muted-foreground/50">
          No running services.
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-0.5">
        <CardButton
          label={`Start ${project.name}`}
          disabled={selectedFiles.length === 0}
          onClick={() => void run("up")}
        >
          <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.75} />
        </CardButton>
        <CardButton
          label={`Restart ${project.name}`}
          disabled={selectedFiles.length === 0}
          onClick={() => void run("restart")}
        >
          <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
        </CardButton>
        <CardButton
          label={`Pull ${project.name}`}
          disabled={selectedFiles.length === 0}
          onClick={() => void run("pull")}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.75} />
        </CardButton>
        <CardButton
          label={`Stop ${project.name}`}
          disabled={selectedFiles.length === 0}
          onClick={() => void run("down", { volumes: false })}
        >
          <HugeiconsIcon icon={StopIcon} size={13} strokeWidth={1.75} />
        </CardButton>
      </div>
    </div>
  );
}

function CardButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground",
        disabled && "opacity-40",
      )}
    >
      {children}
    </button>
  );
}
