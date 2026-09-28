import { invoke } from "@tauri-apps/api/core";

/** Global (not per-host) iroh transport config. The API key itself is never
 *  returned by the backend - only whether one is stored. */
export type IrohConfigView = {
  relayUrls: string[];
  apiKeySet: boolean;
};

export function getIrohConfig(): Promise<IrohConfigView> {
  return invoke<IrohConfigView>("iroh_get_config");
}

/** Replaces the custom relay list. Each entry must parse as an iroh relay
 *  URL; an empty list restores the mode default (n0 public relays, or n0
 *  authenticated relays when an API key is set). */
export function setIrohRelayUrls(urls: string[]): Promise<void> {
  return invoke("iroh_set_relay_urls", { urls });
}

/** Stores the n0 Iroh Services project API key in the OS keychain. An empty
 *  string clears it. */
export function setIrohApiKey(secret: string): Promise<void> {
  return invoke("iroh_set_api_key", { secret });
}

export function clearIrohApiKey(): Promise<void> {
  return invoke("iroh_clear_api_key");
}
