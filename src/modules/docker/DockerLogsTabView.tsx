import { cn } from "@/lib/utils";
import type { DockerLogsTab, Tab } from "@/modules/tabs";
import { DockerLogsPane } from "./DockerLogsPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/** Tab-surface wrapper: the inner inline DockerLogsPane owns the follow
 *  lifecycle (shared refcounted lane with any drawer for the same
 *  container), so this wrapper only mounts the pane. */
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
