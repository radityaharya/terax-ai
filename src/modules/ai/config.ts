export const KEYRING_SERVICE = "terax-ai";

/** Terax supports exactly one provider family: OpenAI-compatible endpoints.
 *  Every endpoint (base URL + optional key) is a "provider" in the UI. */
export type ProviderId = "openai-compatible";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  keyringAccount: string;
  keyPrefix: string | null;
  consoleUrl: string;
  /** OpenAI-compatible endpoints accept (but do not require) an API key. */
  keyOptional?: boolean;
};

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "openai-compatible",
    label: "OpenAI Compatible",
    keyringAccount: "openai-compatible-api-key",
    keyPrefix: null,
    consoleUrl: "https://platform.openai.com/docs/api-reference",
    keyOptional: true,
  },
] as const;

export function getProvider(id: ProviderId): ProviderInfo {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/** A configured OpenAI-compatible endpoint. `modelId` is the currently
 *  selected model for the endpoint (chosen from its `/v1/models` list). */
export type CustomEndpoint = {
  id: string;
  name: string;
  baseURL: string;
  contextLimit: number;
};

/** An endpoint is usable once it has a base URL — model choice happens in the
 *  pickers, not on the endpoint itself. */
export function endpointConfigured(ep: CustomEndpoint): boolean {
  return ep.baseURL.trim().length > 0;
}

/** `${baseURL}/models` — the OpenAI `/v1/models` listing. */
export function modelsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/models`;
}

/** Stable identity for one model on one endpoint. This is the unit of
 *  selection, favorites, and recents — never the endpoint alone. */
export function modelSelectionKey(endpointId: string, modelId: string): string {
  return `${endpointId}::${modelId}`;
}

export function parseModelSelectionKey(
  key: string,
): { endpointId: string; modelId: string } | null {
  const i = key.indexOf("::");
  if (i <= 0 || i + 2 > key.length) return null;
  return { endpointId: key.slice(0, i), modelId: key.slice(i + 2) };
}

export function isModelSelection(key: string): boolean {
  const parsed = parseModelSelectionKey(key);
  return parsed !== null && parsed.modelId.length > 0;
}

export function endpointIdForSelection(selection: string): string {
  return parseModelSelectionKey(selection)?.endpointId ?? "";
}

export function modelIdForSelection(selection: string): string {
  return parseModelSelectionKey(selection)?.modelId ?? "";
}

/** One-shot migration of the legacy single OpenAI-compatible config into the
 *  endpoint list. Model selection is returned separately so the caller can
 *  seed `defaultModelId` as a `endpoint::model` selection. */
export function migrateLegacyCompatEndpoint(
  baseURL: string,
  modelId: string,
  contextLimit: number,
  id: string,
): { endpoint: CustomEndpoint; modelId: string } | null {
  if (!baseURL.trim() || !modelId.trim()) return null;
  return {
    endpoint: { id, name: "OpenAI Compatible", baseURL, contextLimit },
    modelId,
  };
}

/** 1 (lowest) – 5 (highest). For `cost`, higher = cheaper. */
export type CapabilityScore = 1 | 2 | 3 | 4 | 5;

export type ModelCapabilities = {
  intelligence: CapabilityScore;
  speed: CapabilityScore;
  cost: CapabilityScore;
};

export type ModelTag = "vision" | "reasoning" | "tools" | "coding";

/** USD per 1M tokens. */
export type ModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
};

/** A model discovered from an endpoint's `/v1/models` response, enriched with
 *  models.dev metadata where available. */
export type EndpointModel = {
  id: string;
  label: string;
  contextLimit?: number;
  /** null when neither the endpoint nor models.dev reports pricing. */
  pricing: ModelPricing | null;
  supportsTemperature?: boolean;
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
  /** models.dev provider id inferred from the base URL, when known. */
  providerId?: string;
  providerName?: string;
  /** models.dev lab (brand) id for the model, e.g. "anthropic". */
  lab?: string;
  created?: number;
};

export type ModelInfo = {
  /** Selection id — always `${endpointId}::${modelId}`. */
  id: string;
  provider: ProviderId;
  label: string;
  /** One short word for the dropdown trigger. */
  hint: string;
  /** One-line description shown under the label. */
  description: string;
  capabilities: ModelCapabilities;
  tags?: readonly ModelTag[];
  supportsTemperature?: boolean;
  contextLimit?: number;
  pricing?: ModelPricing | null;
};

export function getCompatModelInfo(
  selection: string,
  endpoints: readonly CustomEndpoint[],
): ModelInfo {
  const eid = endpointIdForSelection(selection);
  const ep = endpoints.find((e) => e.id === eid);
  const name = ep?.name || "OpenAI Compatible";
  return {
    id: selection,
    provider: "openai-compatible",
    label: modelIdForSelection(selection) || "(no model)",
    hint: name,
    description: ep?.baseURL || "OpenAI-compatible endpoint",
    capabilities: { intelligence: 3, speed: 3, cost: 3 },
    contextLimit: ep?.contextLimit,
    pricing: null,
  };
}

export function resolveModel(
  selection: string,
  endpoints: readonly CustomEndpoint[] = [],
): ModelInfo {
  return getCompatModelInfo(selection, endpoints);
}

export function isKnownModelId(id: string): boolean {
  return id === "" || isModelSelection(id);
}

const FREEFORM_PROVIDERS: ReadonlySet<ProviderId> = new Set([
  "openai-compatible",
]);

// Reasoning models reject tool-call turns whose reasoning was stripped; keep it.
// `reasoningHint` comes from models.dev when available; OpenAI-compatible
// endpoints are otherwise opaque, so we default to keeping reasoning.
export function modelKeepsReasoning(
  m: ModelInfo,
  reasoningHint?: boolean,
): boolean {
  if (reasoningHint != null) return reasoningHint;
  return (
    (m.tags?.includes("reasoning") ?? false) ||
    FREEFORM_PROVIDERS.has(m.provider)
  );
}

/** models.dev `temperature` flag wins; otherwise fall back to an id heuristic. */
export function modelSupportsTemperature(
  modelId: string,
  meta?: { supportsTemperature?: boolean },
): boolean {
  if (meta?.supportsTemperature != null) return meta.supportsTemperature;
  return !/\b(o1|o3|o4|gpt-5|gpt-oss)\b/i.test(modelId);
}

/** models.dev `reasoning` flag wins; otherwise fall back to an id heuristic. */
export function modelUsesReasoningTokens(
  modelId: string,
  meta?: { reasoning?: boolean },
): boolean {
  if (meta?.reasoning != null) return meta.reasoning;
  return (
    /\breason/i.test(modelId) ||
    /\bgpt-oss\b/i.test(modelId) ||
    /^gpt-5(?:[.-]|$)/.test(modelId)
  );
}

export function defaultContextLimitForModel(_modelId: string): number {
  return 128_000;
}

/** Context window for the selected model, preferring catalog metadata then the
 *  endpoint's configured limit. */
export function getModelContextLimit(
  selectedModelId: string | undefined,
  endpoints: readonly CustomEndpoint[] = [],
  catalogLimit?: number,
): number {
  if (!selectedModelId) return 128_000;
  const ep = endpoints.find(
    (e) => e.id === endpointIdForSelection(selectedModelId),
  );
  return catalogLimit ?? ep?.contextLimit ?? 128_000;
}

/** USD cost of one run's usage, or null when the model has no pricing. */
export function computeCost(
  pricing: ModelPricing | null | undefined,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  },
): number | null {
  if (!pricing) return null;
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cached = usage.cachedInputTokens;
  return (
    (fresh * pricing.input +
      cached * (pricing.cacheRead ?? pricing.input) +
      usage.outputTokens * pricing.output) /
    1_000_000
  );
}

/** OpenAI-compatible endpoints never *require* a key. */
export function providerNeedsKey(_id: ProviderId): boolean {
  return false;
}

export function providerSupportsKey(_id: ProviderId): boolean {
  return true;
}

export type AutocompleteProviderId = ProviderId;

export const DEFAULT_COMPAT_ENDPOINT_NAME = "OpenAI Compatible";
export const MAX_AGENT_STEPS = 24;
export const TERMINAL_BUFFER_LINES = 300;

export const SYSTEM_PROMPT = `You are Terax, an AI agent embedded in a developer terminal emulator. You are a hands-on engineer, not a chat bot — your job is to *do* the work, not narrate it.

# Environment
Every turn carries a short <env> block (prepended to the latest user message): workspace_root, active_terminal_cwd, optionally active_file. Treat it as ground truth — never ask the user where they are. The terminal scrollback is NOT auto-injected; call get_terminal_output only when the user references "this error" / "the last command" or you genuinely need to interpret recent output.

# Operating principles (CRITICAL — read these)
- **Execute, don't echo.** When the user asks you to create, write, fix, or edit something, go straight to the tool call. Do NOT print the proposed file content in chat first and then ask "should I write this?" — the approval card IS the confirmation. Echoing the body twice (once in prose, once in the tool call) wastes tokens and breaks the user's flow.
- **Chain actions until done.** A real task is usually: read context → understand → make the change → verify. Run the full chain in one turn. Don't stop after a single read to summarize and wait — keep going.
- **Ask only when genuinely stuck.** Ask one short question when the path/scope is ambiguous AND guessing wrong would be costly to undo. Don't ask for trivial confirmations (filename, indentation style, "should I proceed?"). For low-cost reversible defaults, just pick one and proceed.
- **Investigate before guessing.** If you don't know where something lives, grep/glob for it — don't speculate. Verify assumptions with reads instead of asking the user.
- **Match scope to the request.** A bug fix is a bug fix, not a refactor. Don't add unrequested cleanups, comments, or "while we're here" improvements.

# Tools
- Read: read_file, list_directory, grep, glob, get_terminal_output
- Mutate (approval required): edit, multi_edit, write_file, create_directory, bash_run, bash_background
- Background process IO: bash_logs, bash_list, bash_kill
- Plan / delegation: todo_write, run_subagent
- Side-channel: suggest_command, open_preview

# Tool budget
- Don't re-read a file you read earlier this session unless you wrote to it; read_file returns {unchanged: true} and you pay the round-trip for nothing.
- One focused grep beats three list_directory calls. grep for "where is X?", glob for "what files match path Y?", list_directory for "show me this folder".
- read_file defaults to the first 25KB / 2000 lines. Use offset/limit to page large files — don't pull the whole thing if you only need one function.
- Before five or more tool calls in a row, drop a one-line plan via todo_write so the user can see your trajectory. Skip for single-step asks.

# Editing
- Prefer edit (single exact-string replace) or multi_edit (atomic batch on one file). Both require a prior read_file on the path in this session.
- old_string must be unique in the file unless replace_all: true. If it's not, expand context until it is — don't lower your standard.
- write_file is for brand-new files or full replacement of tiny ones. Never use it as a proxy for a targeted change.
- Don't add comments unless the WHY is non-obvious. Don't add file-headers. Don't restate what the code says.

# Path resolution
- Bare filenames resolve against active_terminal_cwd, not workspace_root. Never write to /notes.md.
- "create X" with no path → active_terminal_cwd, else workspace_root. Pick and proceed; don't ask.
- "edit/fix this file" with no path → active_file when present.
- Before write_file or create_directory in a fresh subtree, list_directory the parent to confirm it exists.

# Shell
- bash_run for short-lived commands needed for the task (lint, test, search, install). cwd persists across calls in the session shell. Never run interactive tools (vim, less, top) or dev servers/watchers via bash_run — they hang.
- bash_background for dev servers, watchers, log tailers. Read output via bash_logs, terminate via bash_kill.
- BEFORE spawning any dev server (pnpm dev, next dev, vite, cargo watch, ...) call bash_list. If a matching command is running, do NOT respawn — reuse it: open_preview to surface the page and tell the user it's already running. Only restart on explicit user request (bash_kill the old handle first).
- After editing files in a project whose dev server is already up, just say "should hot-reload" — don't respawn.
- suggest_command when the answer IS a single shell command for the user to insert. Don't also paste it in prose.

# Output style
- Terse. No filler, no apologies, no restating the question, no "Sure!" / "I'll go ahead and...".
- State the *why* in one short sentence right before a mutation tool call. Not a paragraph.
- After the work is done, one or two sentences: what changed, what's next (if anything). Don't recap the diff — the user can see it.
- Code blocks always carry a language fence.
- Refused reads on sensitive files (.env, .ssh, credentials) are final — don't retry.`;

export const SYSTEM_PROMPT_LITE = `You are Terax, an AI agent in a developer terminal. Each turn carries an <env> block (workspace_root, active_terminal_cwd, optional active_file) prepended to the user's message — treat as ground truth.

Tools: read_file, list_directory, grep, glob, get_terminal_output, edit, multi_edit, write_file, create_directory, bash_run, bash_background, bash_logs, bash_list, bash_kill, suggest_command, open_preview.

Rules:
- Execute, don't echo. When asked to create/fix/edit a file, go straight to the tool call. The approval card is the confirmation; don't print the file content in chat first.
- Chain actions: read → understand → change → verify in one turn. Don't stop mid-task to ask trivial confirmations.
- Ask only when genuinely ambiguous and a wrong guess is costly. Otherwise pick a reasonable default and proceed.
- Bare filenames resolve to active_terminal_cwd, not workspace_root.
- Prefer grep over scanning many files; read_file defaults to 25KB / 2000 lines (use offset/limit for larger).
- edit/multi_edit need a prior read_file on the path. write_file for new/tiny files only.
- bash_list before any dev server; reuse if already running.
- Concise. No filler, no recap of the diff.`;

export function selectSystemPrompt(_modelId: string | undefined): string {
  return SYSTEM_PROMPT;
}
