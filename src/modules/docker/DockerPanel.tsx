import { useEffect } from "react";
import { daemonLabel } from "./lib/capabilities";
import { useDockerStore } from "./lib/dockerStore";

type Props = {
  /** Active tab's host id (null = local/WSL: v1 shows an empty state). */
  hostId: string | null;
  hostAlias?: string | null;
};

/**
 * D0 placeholder: proves the rail tab, host scoping, and the capabilities
 * round-trip. Full browse/lifecycle lands in D2.
 */
export function DockerPanel({ hostId, hostAlias }: Props) {
  const daemon = useDockerStore((s) =>
    hostId ? (s.byHost[hostId]?.daemon ?? { status: "unknown" as const }) : null,
  );
  const refreshCapabilities = useDockerStore((s) => s.refreshCapabilities);

  useEffect(() => {
    if (hostId) void refreshCapabilities(hostId);
  }, [hostId, refreshCapabilities]);

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
    <div className="flex h-full min-h-0 flex-col">
      <PanelTitle
        title="Docker"
        subtitle={hostAlias ?? hostId}
        right={
          <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {daemon ? daemonLabel(daemon) : "Docker"}
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {daemon?.status === "ready" ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground/70">
            Connected — container browser lands in D2.
          </div>
        ) : daemon?.status === "checking" || daemon?.status === "unknown" ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground/70">
            Checking Docker…
          </div>
        ) : (
          <div className="py-6 text-center text-[11px] text-muted-foreground/70">
            {daemonLabel(daemon ?? { status: "unknown" })}
            {daemon && "message" in daemon && daemon.message ? (
              <div className="mt-1 break-words text-[10px]">{daemon.message}</div>
            ) : null}
          </div>
        )}
      </div>
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
