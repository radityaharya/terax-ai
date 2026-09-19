import { invoke } from "@tauri-apps/api/core";
import { useHostStore } from "./hostStore";

/**
 * Keep-alive model: background hosts stay connected forever so jumping
 * between tabs is instant. `ssh_disconnect` fires only on host delete or an
 * explicit disconnect action. These two functions remain as no-ops for
 * existing call sites.
 */
export function markHostActive(_hostId: string | null): void {}

export function cancelIdleDisconnect(_hostId: string): void {}

/** Drop a host's RPC channel (host delete / explicit disconnect). */
export function disconnectHost(hostId: string): void {
  void invoke("ssh_disconnect", { hostId })
    .then(() => {
      useHostStore.getState().setConnection(hostId, { state: "unknown" });
    })
    .catch(() => {});
}
