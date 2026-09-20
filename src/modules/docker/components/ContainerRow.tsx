import {
  ArrowUpRight01Icon,
  ComputerTerminal02Icon,
  Delete02Icon,
  File02Icon,
  PlayIcon,
  RotateClockwiseIcon,
  StopIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  containerId,
  containerName,
  containerState,
  containerTone,
} from "../lib/container";
import { confirmDockerAction } from "../lib/dockerConfirmStore";
import { useDockerStore, type ContainerAction, type StatsSample } from "../lib/dockerStore";
import type { DockerContainer } from "../lib/types";
import { ResourceRow, type ResourceRowAction } from "./ResourceRow";
import { StatsChips } from "./StatsChips";

type Props = {
  hostId: string;
  container: DockerContainer;
  hostAlias?: string | null;
  stats?: StatsSample | null;
  onInspect?: () => void;
  onLogs?: () => void;
  onLogsTab?: () => void;
  onExec?: () => void;
  /** Hide the lifecycle actions (read-only context, e.g. a preview list). */
  readOnly?: boolean;
};

/**
 * A container row with its full lifecycle: the single place that maps a
 * `DockerContainer` to actions + confirmation. Reused by the containers
 * list and by compose project cards (per-service control), so both behave
 * identically.
 */
export function ContainerRow({
  hostId,
  container,
  hostAlias,
  stats,
  onInspect,
  onLogs,
  onLogsTab,
  onExec,
  readOnly,
}: Props) {
  const containerAction = useDockerStore((s) => s.containerAction);
  const busy = useDockerStore(
    (s) => s.byHost[hostId]?.busyContainers[containerId(container)],
  );

  const id = containerId(container);
  const name = containerName(container);
  const state = containerState(container);
  const running = state === "running";
  const detail = String(container.Status ?? container.Image ?? "");

  const runAction = async (action: ContainerAction) => {
    const actionMeta: Record<
      ContainerAction,
      {
        title: string;
        label: string;
        variant: "destructive" | "warning" | "default";
        desc: string;
      }
    > = {
      start: {
        title: "Start container",
        label: "Start",
        variant: "default",
        desc: "Starts the stopped container process.",
      },
      stop: {
        title: "Stop container",
        label: "Stop",
        variant: "warning",
        desc: "Stops the running container process (SIGTERM, then SIGKILL if unresponsive).",
      },
      restart: {
        title: "Restart container",
        label: "Restart",
        variant: "warning",
        desc: "Restarts the running container process.",
      },
      kill: {
        title: "Kill container",
        label: "Kill",
        variant: "destructive",
        desc: "Sends SIGKILL immediately. Unsaved data will be lost.",
      },
      remove: {
        title: "Remove container",
        label: "Remove",
        variant: "destructive",
        desc: "Permanently removes the container. Data outside volumes is lost.",
      },
    };
    const meta = actionMeta[action];
    const confirmed = await confirmDockerAction({
      title: meta.title,
      actionLabel: meta.label,
      actionVariant: meta.variant,
      resourceKind: "Container",
      resourceName: name,
      resourceDetails: container.Image
        ? `ID: ${id.slice(0, 12)} · Image: ${String(container.Image)}`
        : `ID: ${id.slice(0, 12)}`,
      hostAlias: hostAlias ?? hostId,
      description: meta.desc,
    });
    if (!confirmed) return;
    void containerAction(hostId, action, [id], { force: true });
  };

  const actions: ResourceRowAction[] = [];
  if (running) {
    actions.push(
      {
        key: "stop",
        label: `Stop ${name}`,
        icon: <HugeiconsIcon icon={StopIcon} size={13} strokeWidth={1.75} />,
        onClick: () => void runAction("stop"),
      },
      {
        key: "restart",
        label: `Restart ${name}`,
        icon: (
          <HugeiconsIcon icon={RotateClockwiseIcon} size={13} strokeWidth={1.75} />
        ),
        onClick: () => void runAction("restart"),
      },
      {
        key: "kill",
        label: `Kill ${name}`,
        icon: <HugeiconsIcon icon={ZapIcon} size={13} strokeWidth={1.75} />,
        onClick: () => void runAction("kill"),
        danger: true,
      },
    );
  } else {
    actions.push({
      key: "start",
      label: `Start ${name}`,
      icon: <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.75} />,
      onClick: () => void runAction("start"),
    });
  }
  if (onLogs) {
    actions.push({
      key: "logs",
      label: `Logs for ${name}`,
      icon: <HugeiconsIcon icon={File02Icon} size={13} strokeWidth={1.75} />,
      onClick: onLogs,
    });
  }
  if (onLogsTab) {
    actions.push({
      key: "logs-tab",
      label: `Open logs for ${name} in a tab`,
      icon: (
        <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={1.75} />
      ),
      onClick: onLogsTab,
    });
  }
  if (running && onExec) {
    actions.push({
      key: "exec",
      label: `Exec shell in ${name}`,
      icon: (
        <HugeiconsIcon
          icon={ComputerTerminal02Icon}
          size={13}
          strokeWidth={1.75}
        />
      ),
      onClick: onExec,
    });
  }
  if (!readOnly) {
    actions.push({
      key: "remove",
      label: `Remove ${name}`,
      icon: <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />,
      onClick: () => void runAction("remove"),
      danger: true,
    });
  }

  return (
    <ResourceRow
      tone={containerTone(state)}
      toneLabel={state}
      title={
        <>
          <span className="min-w-0 truncate">{name}</span>
          {busy ? (
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground/70">
              {busy === "remove" ? "removing…" : `${busy}ing…`}
            </span>
          ) : null}
        </>
      }
      subtitle={detail}
      footer={
        running && stats ? <StatsChips stats={stats} /> : undefined
      }
      actions={actions}
      onClick={onInspect}
      className="items-start"
    />
  );
}
