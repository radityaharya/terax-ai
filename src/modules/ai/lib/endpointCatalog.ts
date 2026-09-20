import { create } from "zustand";
import {
  type CustomEndpoint,
  type EndpointModel,
  type ModelPricing,
  modelsUrl,
} from "../config";
import { lookupModelMetadata, useModelMetadata } from "./modelMetadata";
import { createProxyFetch } from "./proxyFetch";

const proxyFetch = createProxyFetch({ allowPrivateNetwork: true });

const CACHE_TTL_MS = 5 * 60_000;

type CatalogEntry = {
  models: EndpointModel[];
  fetchedAt: number;
  error: string | null;
};

type CatalogState = {
  entries: Record<string, CatalogEntry>;
  loading: Record<string, boolean>;
  load: (
    endpoint: CustomEndpoint,
    apiKey: string | null,
    force?: boolean,
  ) => Promise<EndpointModel[]>;
  get: (endpointId: string) => EndpointModel[] | undefined;
};

export const useEndpointCatalog = create<CatalogState>((set, get) => ({
  entries: {},
  loading: {},

  get: (endpointId) => get().entries[endpointId]?.models,

  load: async (endpoint, apiKey, force = false) => {
    const baseURL = endpoint.baseURL.trim();
    if (!baseURL) return [];
    const existing = get().entries[endpoint.id];
    if (!force && existing && Date.now() - existing.fetchedAt < CACHE_TTL_MS) {
      return existing.models;
    }
    if (get().loading[endpoint.id]) return existing?.models ?? [];
    set((s) => ({ loading: { ...s.loading, [endpoint.id]: true } }));
    try {
      const res = await proxyFetch(modelsUrl(baseURL), {
        method: "GET",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      }
      const payload = (await res.json()) as unknown;
      // models.dev enriches pricing/context/capabilities. Bounded so a slow
      // metadata fetch never blocks the endpoint's own model list.
      await Promise.race([
        useModelMetadata.getState().load(),
        new Promise((resolve) => setTimeout(resolve, 8_000)),
      ]);
      const models = parseModelList(payload, baseURL);
      set((s) => ({
        entries: {
          ...s.entries,
          [endpoint.id]: { models, fetchedAt: Date.now(), error: null },
        },
        loading: { ...s.loading, [endpoint.id]: false },
      }));
      return models;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({
        entries: {
          ...s.entries,
          [endpoint.id]: {
            models: s.entries[endpoint.id]?.models ?? [],
            fetchedAt: Date.now(),
            error: message,
          },
        },
        loading: { ...s.loading, [endpoint.id]: false },
      }));
      return [];
    }
  },
}));

export function endpointCatalogError(endpointId: string): string | null {
  return useEndpointCatalog.getState().entries[endpointId]?.error ?? null;
}

function parseModelList(payload: unknown, baseURL: string): EndpointModel[] {
  const root = payload as { data?: unknown; models?: unknown } | null;
  const arr = Array.isArray(root?.data)
    ? root?.data
    : Array.isArray(root?.models)
      ? root?.models
      : Array.isArray(payload)
        ? payload
        : [];
  const models: EndpointModel[] = [];
  for (const raw of arr) {
    const m = parseModel(raw, baseURL);
    if (m) models.push(m);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

function parseModel(raw: unknown, baseURL: string): EndpointModel | null {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return null;
  const id =
    typeof m.id === "string"
      ? m.id
      : typeof m.name === "string"
        ? m.name
        : null;
  if (!id) return null;
  const meta = lookupModelMetadata(baseURL, id);
  const endpointLabel =
    typeof m.name === "string" && m.name.trim() ? m.name.trim() : null;
  const contextLimit =
    firstNumber(m.context_length, m.context_window, m.max_context_length) ??
    firstNumber(
      (m.top_provider as Record<string, unknown> | undefined)?.context_length,
    ) ??
    meta?.contextLimit;
  const vision =
    meta?.attachment === true ||
    (meta?.modalities.input.includes("image") ?? false);
  return {
    id,
    label: endpointLabel ?? meta?.name ?? id,
    contextLimit: contextLimit ?? undefined,
    pricing: parsePricing(m) ?? meta?.pricing ?? null,
    supportsTemperature: meta?.temperature,
    reasoning: meta?.reasoning,
    toolCall: meta?.toolCall,
    vision,
    providerId: meta?.providerId,
    providerName: meta?.providerName,
    lab: meta?.lab ?? undefined,
    created: firstNumber(m.created) ?? undefined,
  };
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    const n = toNumber(v);
    if (n != null) return n;
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parsePricing(m: Record<string, unknown>): ModelPricing | null {
  const p = m.pricing as Record<string, unknown> | undefined;
  if (p && typeof p === "object") {
    const prompt = toNumber(p.prompt);
    const completion = toNumber(p.completion);
    if (prompt != null || completion != null) {
      const cacheRead = toNumber(p.input_cache_read);
      return {
        input: (prompt ?? 0) * 1_000_000,
        output: (completion ?? 0) * 1_000_000,
        cacheRead: cacheRead != null ? cacheRead * 1_000_000 : undefined,
      };
    }
    // Some gateways report already-normalized per-1M pricing.
    const input = toNumber(p.input);
    const output = toNumber(p.output);
    if (input != null || output != null) {
      const cacheRead = toNumber(p.cache_read ?? p.cacheRead);
      return {
        input: input ?? 0,
        output: output ?? 0,
        cacheRead: cacheRead ?? undefined,
      };
    }
  }
  // Flat per-1M fields on the model itself.
  const input = toNumber(m.input_cost_per_million ?? m.input_price);
  const output = toNumber(m.output_cost_per_million ?? m.output_price);
  if (input != null || output != null) {
    return { input: input ?? 0, output: output ?? 0 };
  }
  return null;
}
