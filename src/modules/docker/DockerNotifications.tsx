import { useEffect, useRef } from "react";
import { evaluateEvent, underReplicatedNotification, updateAvailableNotification } from "./lib/notify";
import { mutedRules, useDockerStore } from "./lib/dockerStore";

type OpenTarget = {
  kind: "container" | "service";
  id: string;
  title: string;
};

type Props = {
  hostId: string | null;
  onOpenLogs: (target: OpenTarget) => void;
};

/**
 * Headless watcher: streams `docker events` per active SSH host, evaluates
 * notification rules, and fires OS toasts. Also watches service replica
 * health + image updates from the store snapshots.
 *
 * Mount once in App. Never renders anything.
 */
export function DockerNotifications({ hostId, onOpenLogs }: Props) {
  const onOpenLogsRef = useRef(onOpenLogs);
  onOpenLogsRef.current = onOpenLogs;
  const seenRef = useRef(new Set<string>());
  const seenServicesRef = useRef(new Set<string>());
  const seenUpdatesRef = useRef(new Set<string>());

  const feed = useDockerStore((s) => (hostId ? (s.byHost[hostId]?.eventsFeed ?? null) : null));
  const startEventsFeed = useDockerStore((s) => s.startEventsFeed);
  const pollEventsFeed = useDockerStore((s) => s.pollEventsFeed);
  const updates = useDockerStore((s) => (hostId ? (s.byHost[hostId]?.updates ?? {}) : {}));

  // Keep one background events stream per active host.
  useEffect(() => {
    if (!hostId) return;
    seenRef.current.clear();
    void startEventsFeed(hostId);
  }, [hostId, startEventsFeed]);

  useEffect(() => {
    if (!hostId || feed?.phase !== "streaming") return;
    const t = setInterval(() => {
      void pollEventsFeed(hostId);
    }, 3000);
    return () => clearInterval(t);
  }, [hostId, feed?.phase, pollEventsFeed]);

  // Evaluate fresh events.
  useEffect(() => {
    if (!hostId || !feed) return;
    const muted = new Set(mutedRules(hostId));
    for (const ev of feed.events) {
      const n = evaluateEvent(hostId, ev, new Set());
      if (!n || seenRef.current.has(n.id)) continue;
      seenRef.current.add(n.id);
      if (muted.has(n.rule)) continue;
      void fireToast(n.title, n.body, n.target);
    }
    async function fireToast(title: string, body: string, target?: OpenTarget) {
      try {
        const { toast } = await import("sonner");
        toast.warning(title, {
          description: body,
          ...(target
            ? { action: { label: "Open logs", onClick: () => onOpenLogsRef.current(target) } }
            : {}),
        });
      } catch {
        // sonner unavailable — ignore
      }
    }
  }, [hostId, feed]);

  // Under-replicated services: derived from service_ls replicaHealth in a
  // later phase (D7). Hook point kept here so D7 only adds the watcher.
  useEffect(() => {
    void updates;
    void seenUpdatesRef;
    void seenServicesRef;
    void underReplicatedNotification;
    void updateAvailableNotification;
  }, [updates]);

  return null;
}
