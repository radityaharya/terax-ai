import { cn } from "@/lib/utils";
import { ArrowUp01Icon, ArrowDown01Icon, PlayIcon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { confirmDockerAction } from "../lib/dockerConfirmStore";
import { useDockerStore, type ComposeProjectState } from "../lib/dockerStore";

type Props = {
  hostId: string;
  project: ComposeProjectState;
  containerNames: Record<string, string>;
  onOpenLogs: (containerId: string, title: string) => void;
};

/** Compose project card: grouped containers + up/down/restart/pull. */
export function ComposeCard({ hostId, project, containerNames, onOpenLogs }: Props) {
  const composeAction = useDockerStore((s) => s.composeAction);

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

    const confirmed = await confirmDockerAction({
      title: meta.title,
      actionLabel: meta.label,
      actionVariant: meta.variant,
      resourceKind: "Compose Project",
      resourceName: project.name,
      resourceDetails: `${project.containers.length} container(s) · ${project.files.map((f) => f.split("/").pop()).join(", ")}`,
      hostAlias: hostId,
      description: meta.desc,
    });
    if (!confirmed) return;

    void composeAction(hostId, project.name, action, opts);
  };

  return (
    <div className="rounded-md border border-border/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
          {project.name}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {project.containers.length} svc
        </span>
        {project.loading ? (
          <span className="shrink-0 text-[10px] text-muted-foreground/70">working…</span>
        ) : null}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground/60" title={project.files.join("\n")}>
        {project.files.map((f) => f.split("/").pop()).join(", ")}
      </div>
      {project.error ? (
        <div className="mt-0.5 break-words text-[10px] text-destructive">{project.error}</div>
      ) : null}
      {project.containers.length > 0 ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {project.containers.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onOpenLogs(id, containerNames[id] ?? id.slice(0, 12))}
              title="Open container logs"
              className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
              <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
                {containerNames[id] ?? id.slice(0, 12)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-0.5">
        <CardButton label={`Start ${project.name}`} onClick={() => void run("up")}>
          <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.75} />
        </CardButton>
        <CardButton label={`Restart ${project.name}`} onClick={() => void run("restart")}>
          <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
        </CardButton>
        <CardButton label={`Pull ${project.name}`} onClick={() => void run("pull")}>
          <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.75} />
        </CardButton>
        <CardButton label={`Stop ${project.name}`} onClick={() => void run("down", { volumes: false })}>
          <HugeiconsIcon icon={ArrowUp01Icon} size={13} strokeWidth={1.75} />
        </CardButton>
      </div>
    </div>
  );
}

function CardButton({
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
      className={cn(
        "flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
