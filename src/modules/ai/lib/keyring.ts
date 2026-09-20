import { invoke } from "@tauri-apps/api/core";
import { KEYRING_SERVICE, type CustomEndpoint } from "../config";

/** Per-endpoint API keys, keyed by {@link CustomEndpoint.id}. */
export type CustomEndpointKeys = Record<string, string | null>;

function compatKeyringAccount(endpointId: string): string {
  return `compat-${endpointId}-api-key`;
}

export async function getCustomEndpointKey(
  endpointId: string,
): Promise<string | null> {
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: compatKeyringAccount(endpointId),
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function setCustomEndpointKey(
  endpointId: string,
  key: string,
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: compatKeyringAccount(endpointId),
    password: trimmed,
  });
}

export async function clearCustomEndpointKey(
  endpointId: string,
): Promise<void> {
  try {
    await invoke("secrets_delete", {
      service: KEYRING_SERVICE,
      account: compatKeyringAccount(endpointId),
    });
  } catch {}
}

export async function getAllCustomEndpointKeys(
  endpoints: readonly CustomEndpoint[],
): Promise<CustomEndpointKeys> {
  if (endpoints.length === 0) return {};
  const out: CustomEndpointKeys = {};
  try {
    const accounts = endpoints.map((e) => compatKeyringAccount(e.id));
    const results = await invoke<(string | null)[]>("secrets_get_all", {
      service: KEYRING_SERVICE,
      accounts,
    });
    endpoints.forEach((e, i) => {
      const v = results[i];
      out[e.id] = v && v.length > 0 ? v : null;
    });
  } catch {
    for (const e of endpoints) {
      out[e.id] = await getCustomEndpointKey(e.id);
    }
  }
  return out;
}

/** True when at least one endpoint has a base URL configured. */
export function hasConfiguredEndpoint(
  endpoints: readonly CustomEndpoint[],
): boolean {
  return endpoints.some((e) => e.baseURL.trim().length > 0);
}
