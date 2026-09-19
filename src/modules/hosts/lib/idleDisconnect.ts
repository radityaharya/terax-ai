import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useHostStore } from "./hostStore";

const IDLE_MS = 10 * 60 * 1000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(hostId: string): void {
  const t = timers.get(hostId);
  if (t) {
    clearTimeout(t);
    timers.delete(hostId);
  }
}

/**
 * Call when a host becomes active (cancels any pending disconnect) or
 * inactive (starts the idle countdown). After 10 minutes without returning,
 * the RPC channel is dropped; PTY tabs stay open and reconnect on demand.
 */
export function markHostActive(hostId: string | null): void {
  const { hosts } = useHostStore.getState();
  for (const host of hosts) {
    if (host.id === hostId) {
      clearTimer(host.id);
    } else if (!timers.has(host.id)) {
      const timer = setTimeout(() => {
        timers.delete(host.id);
        void invoke("ssh_disconnect", { hostId: host.id })
          .then(() => {
            useHostStore.getState().setConnection(host.id, { state: "unknown" });
          })
          .catch(() => {});
        toast.info(`Disconnected from ${host.alias} (idle)`, {
          description: "Reconnect from the Hosts tab to resume.",
        });
      }, IDLE_MS);
      timers.set(host.id, timer);
    }
  }
}

export function cancelIdleDisconnect(hostId: string): void {
  clearTimer(hostId);
}
