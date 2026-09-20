import { create } from "zustand";
import type { ModelPricing } from "../config";
import { createProxyFetch } from "./proxyFetch";

const MODELS_DEV_URL = "https://models.dev/api.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const LOGO_BASE = "https://models.dev/logos";

const proxyFetch = createProxyFetch({ allowPrivateNetwork: true });

/** Normalized slice of a models.dev model entry. */
export type ModelMetadata = {
  providerId: string;
  providerName: string;
  id: string;
  name: string;
  family?: string;
  /** models.dev lab (brand) id for the model, e.g. "anthropic". */
  lab: string | null;
  reasoning: boolean;
  temperature: boolean;
  toolCall: boolean;
  attachment: boolean;
  modalities: { input: string[]; output: string[] };
  contextLimit?: number;
  outputLimit?: number;
  /** USD per 1M tokens, or null when models.dev has no cost entry. */
  pricing: ModelPricing | null;
  releaseDate?: string;
};

type MetadataState = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  byId: Record<string, ModelMetadata>;
  byProviderAndId: Record<string, ModelMetadata>;
  load: (force?: boolean) => Promise<void>;
};

const EMPTY_INDEXES = { byId: {}, byProviderAndId: {} };

let lastLoadedAt = 0;
let inflight: Promise<void> | null = null;

export const useModelMetadata = create<MetadataState>((set, get) => ({
  status: "idle",
  error: null,
  ...EMPTY_INDEXES,

  load: async (force = false) => {
    const { status } = get();
    if (status === "loading") return inflight ?? Promise.resolve();
    if (!force && status === "ready" && Date.now() - lastLoadedAt < TTL_MS) {
      return;
    }
    set({ status: "loading", error: null });
    inflight = (async () => {
      try {
        const res = await proxyFetch(MODELS_DEV_URL, { method: "GET" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
        }
        const payload = (await res.json()) as unknown;
        const { byId, byProviderAndId } = indexMetadata(payload);
        lastLoadedAt = Date.now();
        set({ status: "ready", error: null, byId, byProviderAndId });
      } catch (e) {
        set({
          status: "error",
          error: e instanceof Error ? e.message : String(e),
          ...EMPTY_INDEXES,
        });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
}));

/** Metadata for a model on an endpoint. Prefers the provider inferred from the
 *  base URL, then falls back to a global id match (and a namespaced-id match). */
export function lookupModelMetadata(
  baseURL: string,
  modelId: string,
): ModelMetadata | null {
  const { byId, byProviderAndId, status } = useModelMetadata.getState();
  if (status !== "ready" || !modelId) return null;
  const providerId = detectProviderId(baseURL);
  if (providerId) {
    const hit = byProviderAndId[`${providerId}/${modelId}`];
    if (hit) return hit;
  }
  const direct = byId[modelId];
  if (direct) return direct;
  const tail = modelId.includes("/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : "";
  return tail ? (byId[tail] ?? null) : null;
}

export function isMetadataReady(): boolean {
  return useModelMetadata.getState().status === "ready";
}

export function providerLogoUrl(
  providerId: string | null | undefined,
): string | null {
  return providerId ? `${LOGO_BASE}/${providerId}.svg` : null;
}

export function labLogoUrl(lab: string | null | undefined): string | null {
  return lab ? `${LOGO_BASE}/labs/${lab}.svg` : null;
}

/** First-party providers whose metadata is preferred over gateways when the
 *  same model id appears under many providers. */
const CANONICAL_LABS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "mistral",
  "meta",
  "qwen",
  "moonshotai",
  "zai",
  "cohere",
  "microsoft",
  "amazon",
  "nvidia",
  "perplexity",
  "allenai",
  "ibm",
  "tii",
  "01-ai",
  "xiaomi",
  "stepfun",
  "internlm",
  "minimax",
  "baidu",
  "tencent",
  "bytedance",
  "inclusionai",
  "liquid",
  "ai21",
  "upstage",
  "reka",
  "sarvam",
  "swiss-ai",
  "openbmb",
  "alibaba",
  "nousresearch",
]);

// Longer / more specific prefixes first so e.g. `gpt-oss` resolves before `gpt`.
const LAB_PREFIXES: ReadonlyArray<[string, string]> = [
  ["claude", "anthropic"],
  ["text-embedding", "openai"],
  ["dall-e", "openai"],
  ["gpt", "openai"],
  ["sora", "openai"],
  ["whisper", "openai"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["imagen", "google"],
  ["nano-banana", "google"],
  ["lyria", "google"],
  ["veo", "google"],
  ["deepseek", "deepseek"],
  ["mixtral", "mistral"],
  ["codestral", "mistral"],
  ["magistral", "mistral"],
  ["devstral", "mistral"],
  ["ministral", "mistral"],
  ["pixtral", "mistral"],
  ["voxtral", "mistral"],
  ["mistral", "mistral"],
  ["llama", "meta"],
  ["qwen", "qwen"],
  ["qvq", "qwen"],
  ["qwq", "qwen"],
  ["kimi", "moonshotai"],
  ["glmv", "zai"],
  ["glm", "zai"],
  ["command", "cohere"],
  ["cohere-embed", "cohere"],
  ["aya", "cohere"],
  ["phi", "microsoft"],
  ["wizardlm", "microsoft"],
  ["nova", "amazon"],
  ["titan-embed", "amazon"],
  ["nemotron", "nvidia"],
  ["sonar", "perplexity"],
  ["ernie", "baidu"],
  ["hunyuan", "tencent"],
  ["minimax", "minimax"],
  ["abab", "minimax"],
  ["mimo", "xiaomi"],
  ["step", "stepfun"],
  ["granite", "ibm"],
  ["hermes", "nousresearch"],
  ["jamba", "ai21"],
  ["solar", "upstage"],
  ["reka", "reka"],
  ["sarvam", "sarvam"],
  ["olmo", "allenai"],
  ["ling", "inclusionai"],
  ["ring", "inclusionai"],
  ["internlm", "internlm"],
  ["seed", "bytedance"],
  ["grok", "xai"],
];

/** Best-effort brand (lab) for a model from its models.dev `family`/id. */
export function inferLab(
  family: string | undefined,
  id: string,
): string | null {
  const tail = id.includes("/") ? id.slice(id.indexOf("/") + 1) : "";
  const candidates = [family, id, tail || null].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  for (const raw of candidates) {
    const token = raw.toLowerCase();
    for (const [prefix, lab] of LAB_PREFIXES) {
      if (
        token === prefix ||
        token.startsWith(`${prefix}-`) ||
        token.startsWith(prefix)
      ) {
        return lab;
      }
    }
    // Exact-only short families: "o", "o1", "o3-mini" are OpenAI.
    if (token === "o" || /^o\d/.test(token) || token.startsWith("o-")) {
      return "openai";
    }
    if (token === "yi" || token.startsWith("yi-")) return "01-ai";
  }
  return null;
}

const PROVIDER_HOSTS: ReadonlyArray<[string, string]> = [
  ["api.openai.com", "openai"],
  ["openai.azure.com", "openai"],
  ["api.anthropic.com", "anthropic"],
  ["generativelanguage.googleapis.com", "google"],
  ["api.x.ai", "xai"],
  ["api.deepseek.com", "deepseek"],
  ["api.mistral.ai", "mistral"],
  ["api.groq.com", "groq"],
  ["openrouter.ai", "openrouter"],
  ["cerebras.ai", "cerebras"],
  ["fireworks.ai", "fireworks-ai"],
  ["api.together.xyz", "togetherai"],
];

/** Best-effort provider id from an endpoint base URL (models.dev ids). */
export function detectProviderId(baseURL: string): string | null {
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
    return null;
  }
  for (const [needle, id] of PROVIDER_HOSTS) {
    if (host === needle || host.endsWith(`.${needle}`)) return id;
  }
  return null;
}

function indexMetadata(payload: unknown): {
  byId: Record<string, ModelMetadata>;
  byProviderAndId: Record<string, ModelMetadata>;
} {
  const byId: Record<string, ModelMetadata> = {};
  const byProviderAndId: Record<string, ModelMetadata> = {};
  const providers = payload as Record<string, unknown> | null;
  if (!providers || typeof providers !== "object") {
    return { byId, byProviderAndId };
  }
  for (const [providerKey, rawProvider] of Object.entries(providers)) {
    const provider = rawProvider as {
      id?: unknown;
      name?: unknown;
      models?: Record<string, unknown>;
    } | null;
    if (!provider || typeof provider !== "object") continue;
    const providerId =
      typeof provider.id === "string" ? provider.id : providerKey;
    const providerName =
      typeof provider.name === "string" ? provider.name : providerId;
    const models = provider.models;
    if (!models || typeof models !== "object") continue;
    for (const [modelKey, rawModel] of Object.entries(models)) {
      const meta = normalizeModel(rawModel, providerId, providerName, modelKey);
      if (!meta) continue;
      byProviderAndId[`${providerId}/${meta.id}`] = meta;
      // Prefer a first-party provider's entry for the global id index so a
      // gateway that happens to list the model first can't win.
      const existing = byId[meta.id];
      if (
        !existing ||
        (CANONICAL_LABS.has(meta.providerId) &&
          !CANONICAL_LABS.has(existing.providerId))
      ) {
        byId[meta.id] = meta;
      }
    }
  }
  return { byId, byProviderAndId };
}

function normalizeModel(
  raw: unknown,
  providerId: string,
  providerName: string,
  fallbackId: string,
): ModelMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" && m.id ? m.id : fallbackId;
  if (!id) return null;
  const limit = m.limit as Record<string, unknown> | undefined;
  const modalities = m.modalities as
    | { input?: unknown; output?: unknown }
    | undefined;
  return {
    providerId,
    providerName,
    id,
    name: typeof m.name === "string" && m.name ? m.name : id,
    family: typeof m.family === "string" ? m.family : undefined,
    lab: inferLab(typeof m.family === "string" ? m.family : undefined, id),
    reasoning: m.reasoning === true,
    temperature: m.temperature !== false,
    toolCall: m.tool_call === true,
    attachment: m.attachment === true,
    modalities: {
      input: toStringArray(modalities?.input),
      output: toStringArray(modalities?.output),
    },
    contextLimit: toNumber(limit?.context) ?? undefined,
    outputLimit: toNumber(limit?.output) ?? undefined,
    pricing: normalizeCost(m.cost),
    releaseDate:
      typeof m.release_date === "string" ? m.release_date : undefined,
  };
}

function normalizeCost(raw: unknown): ModelPricing | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const input = toNumber(c.input);
  const output = toNumber(c.output);
  if (input == null && output == null) return null;
  const cacheRead = toNumber(c.cache_read);
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? undefined,
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
