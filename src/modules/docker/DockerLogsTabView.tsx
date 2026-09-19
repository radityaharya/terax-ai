import { useEffect } from "react";
import { cn } from "@/lib/utils";
import type { DockerLogsTab, Tab } from "@/modules/tabs";
import { DockerLogsPane } from "./DockerLogsPane";
import { useDockerStore } from "./lib/dockerStore";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/** Tab-surface wrapper: owns the follow lifecycle so it survives even if
 *  the pane unmounts briefly (unlike the drawer pane, which stops its
 *  follow on unmount). Mounts DockerLogsPane inline. */
function DockerLogsTabPane({
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
  const startLogFollow = useDockerStore((s) => s.startLogFollow);
  const stopLogFollow = useDockerStore((s) => s.stopLogFollow);
  const followId = `${kind}:${id}`;
  useEffect(() => {
    startLogFollow(hostId, kind, id);
    return () => {
      void stopLogFollow(hostId, followId);
    };
    // One follow per mounted tab surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, kind, id]);
  return (
    <DockerLogsPane
      hostId={hostId}
      kind={kind}
      id={id}
      title={title}
      onClose={() => {}}
      inline
    />
  );
}

/** Mounts a DockerLogsPane per docker-logs tab so follows keep state
 *  across tab switches (same stacking contract as EditorStack). */
export function DockerLogsTabView({ tabs, activeId }: Props) {
  const logs = tabs.filter((t): t is DockerLogsTab => t.kind === "docker-logs");
  if (logs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {logs.map((t) => {
        const visible = t.id === activeId;
        const env = t.env;
        const hostId = env && env.kind === "ssh" ? env.hostId : null;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            {hostId ? (
              <DockerLogsTabPane
                key={`${hostId}:${t.targetKind}:${t.targetId}`}
                hostId={hostId}
                kind={t.targetKind}
                id={t.targetId}
                title={t.title}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
                This logs tab lost its host. Close it and reopen from the
                Docker panel.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
