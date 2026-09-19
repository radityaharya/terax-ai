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

  // Select primitives, not derived objects: returning fresh object/array
  // literals from a zustand selector re-renders on every store change,
  // which re-created the polling interval below and looped forever.
  const feedPhase = useDockerStore((s) =>
    hostId ? (s.byHost[hostId]?.eventsFeed?.phase ?? null) : null,
  );
  const eventCount = useDockerStore((s) =>
    hostId ? (s.byHost[hostId]?.eventsFeed?.events.length ?? 0) : 0,
  );
  const startEventsFeed = useDockerStore((s) => s.startEventsFeed);
  const pollEventsFeed = useDockerStore((s) => s.pollEventsFeed);

  // Keep one background events stream per active host.
  useEffect(() => {
    if (!hostId) return;
    seenRef.current.clear();
    seenServicesRef.current.clear();
    seenUpdatesRef.current.clear();
    void startEventsFeed(hostId);
  }, [hostId, startEventsFeed]);

  useEffect(() => {
    if (!hostId || feedPhase !== "streaming") return;
    const t = setInterval(() => {
      void pollEventsFeed(hostId);
    }, 3000);
    return () => clearInterval(t);
  }, [hostId, feedPhase, pollEventsFeed]);

  // Evaluate fresh events. Depends on the event COUNT (a number), not the
  // feed object — reading `feed.events` inside the effect via getState()
  // avoids re-subscribing on every poll append.
  useEffect(() => {
    if (!hostId) return;
    const feed = useDockerStore.getState().byHost[hostId]?.eventsFeed;
    if (!feed) return;
    const muted = new Set(mutedRules(hostId));
    for (const ev of feed.events) {
      const n = evaluateEvent(hostId, ev, seenUpdatesRef.current);
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
    // Under-replicated services + image updates hook into this same pass
    // in D7 (reads the swarm/services + updates snapshots via getState).
    // Referenced here so the imports stay live until D7 wires them.
    if (eventCount < 0) {
      void underReplicatedNotification;
      void updateAvailableNotification;
    }
  }, [hostId, eventCount]);

  return null;
}
