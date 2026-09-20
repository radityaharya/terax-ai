import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type UIMessage,
} from "ai";
import {
  endpointIdForSelection,
  getModelContextLimit,
  MAX_AGENT_STEPS,
  modelIdForSelection,
  modelKeepsReasoning,
  resolveModel,
  selectSystemPrompt,
  type CustomEndpoint,
} from "../config";
import { buildTools, type ToolContext } from "../tools/tools";
import { compactModelMessagesDetailed } from "./compact";
import type { CustomEndpointKeys } from "./keyring";
import { lookupModelMetadata } from "./modelMetadata";
import { prepareAgentPrompt } from "./prompt";
import { createProxyFetch } from "./proxyFetch";

const localProxyFetch = createProxyFetch({ allowPrivateNetwork: true });

const TOOL_LABELS: Record<string, (input: Record<string, unknown>) => string> =
  {
    read_file: (i) => `Reading ${shortPath(i.path)}`,
    list_directory: (i) => `Listing ${shortPath(i.path)}`,
    grep: (i) => `Grepping ${ellipsize(String(i.pattern ?? ""), 40)}`,
    glob: (i) => `Globbing ${ellipsize(String(i.pattern ?? ""), 40)}`,
    edit: (i) => `Editing ${shortPath(i.path)}`,
    multi_edit: (i) => `Editing ${shortPath(i.path)}`,
    write_file: (i) => `Writing ${shortPath(i.path)}`,
    create_directory: (i) => `Creating ${shortPath(i.path)}`,
    bash_run: (i) => `Running ${ellipsize(String(i.command ?? ""), 60)}`,
    bash_background: (i) =>
      `Spawning ${ellipsize(String(i.command ?? ""), 60)}`,
    bash_logs: () => `Reading logs`,
    bash_list: () => `Listing background processes`,
    bash_kill: () => `Stopping background process`,
    suggest_command: (i) =>
      `Suggesting ${ellipsize(String(i.command ?? ""), 60)}`,
    todo_write: (i) =>
      `Updating plan (${Array.isArray(i.todos) ? i.todos.length : 0} items)`,
    run_subagent: (i) => `Spawning ${String(i.type ?? "subagent")} subagent`,
  };

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function ellipsize(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const modelCache = new Map<string, LanguageModel>();

/** Build an OpenAI-compatible model client. Endpoints are opaque: every
 *  request goes through the native proxy so private-network base URLs work. */
export async function buildLanguageModel(
  baseURL: string,
  apiKey: string | null,
  modelId: string,
): Promise<LanguageModel> {
  const base = baseURL.trim();
  if (!base) throw new Error("No base URL configured for this endpoint.");
  if (!modelId.trim()) {
    throw new Error("No model selected. Pick one in Settings → Models.");
  }
  const cacheKey = `${base} ${apiKey ?? ""} ${modelId}`;
  const hit = modelCache.get(cacheKey);
  if (hit) return hit;

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const built = createOpenAICompatible({
    name: "openai-compatible",
    baseURL: base,
    apiKey: apiKey ?? undefined,
    fetch: localProxyFetch,
  })(modelId);
  modelCache.set(cacheKey, built);
  return built;
}

export function endpointForSelection(
  selection: string,
  endpoints: readonly CustomEndpoint[],
): CustomEndpoint {
  const eid = endpointIdForSelection(selection);
  const ep = endpoints.find((e) => e.id === eid);
  if (!ep) {
    throw new Error(
      "The selected endpoint no longer exists. Pick a model in Settings → Models.",
    );
  }
  return ep;
}

export async function buildConfiguredLanguageModel(
  selection: string,
  endpoints: readonly CustomEndpoint[],
  endpointKeys: CustomEndpointKeys,
): Promise<LanguageModel> {
  const ep = endpointForSelection(selection, endpoints);
  return buildLanguageModel(
    ep.baseURL,
    endpointKeys[ep.id] ?? null,
    modelIdForSelection(selection),
  );
}

const PLAN_MODE_PROMPT = `## PLAN MODE — ACTIVE
Mutating tools (write_file, edit, multi_edit, create_directory) will queue their changes for the user to review as a single diff. Do NOT execute bash_run or bash_background while plan mode is active — restrict yourself to reads (read_file, grep, glob, list_directory) and the queued mutations. After queueing the full set of edits, stop and return a brief summary; do not continue acting until the user has accepted/rejected.`;

function buildStableSystem(
  modelId: string,
  persona: { name: string; instructions: string } | null,
  customInstructions: string | undefined,
  projectMemory: string | null,
): string {
  const base = selectSystemPrompt(modelId);
  const personaBlock = persona?.instructions.trim()
    ? `\n\n## ACTIVE AGENT — ${persona.name}\n${persona.instructions.trim()}`
    : "";
  const customBlock = customInstructions?.trim()
    ? `\n\n## USER CUSTOM INSTRUCTIONS — follow unless they conflict with safety rules above\n${customInstructions.trim()}`
    : "";
  const memoryBlock =
    projectMemory && projectMemory.trim().length > 0
      ? `\n\n## PROJECT — TERAX.md\n${projectMemory.trim()}`
      : "";
  return `${base}${memoryBlock}${personaBlock}${customBlock}`;
}

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type AgentUsageDelta = AgentUsage & {
  lastInputTokens: number;
  lastCachedTokens: number;
};

const EMPTY_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

export type RunAgentOptions = {
  endpoints: readonly CustomEndpoint[];
  endpointKeys: CustomEndpointKeys;
  modelId: string;
  customInstructions?: string;
  agentPersona?: { name: string; instructions: string } | null;
  toolContext: ToolContext;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  planMode?: boolean;
  projectMemory?: string | null;
  uiMessages: UIMessage[];
  abortSignal?: AbortSignal;
};

export async function runAgentStream(opts: RunAgentOptions) {
  const selection = opts.modelId;
  if (!selection) {
    throw new Error("No model selected. Add an endpoint in Settings → Models.");
  }
  const ep = endpointForSelection(selection, opts.endpoints);
  const model = await buildLanguageModel(
    ep.baseURL,
    opts.endpointKeys[ep.id] ?? null,
    modelIdForSelection(selection),
  );
  const info = resolveModel(selection, opts.endpoints);
  const metadata = lookupModelMetadata(
    ep.baseURL,
    modelIdForSelection(selection),
  );

  const stableSystem = buildStableSystem(
    selection,
    opts.agentPersona ?? null,
    opts.customInstructions,
    opts.projectMemory ?? null,
  );

  const history = await convertToModelMessages(opts.uiMessages);
  const keepsReasoning = modelKeepsReasoning(info, metadata?.reasoning);
  const prunedHistory = pruneMessages({
    messages: history,
    reasoning: keepsReasoning ? "none" : "before-last-message",
    emptyMessages: "remove",
  });
  const catalogLimit = opts.endpoints.find(
    (e) => e.id === endpointIdForSelection(selection),
  )?.contextLimit;
  const compact = compactModelMessagesDetailed(
    prunedHistory,
    getModelContextLimit(selection, opts.endpoints, catalogLimit),
  );
  const compactedHistory = compact.messages;
  if (compact.compacted) {
    opts.onCompact?.({ droppedCount: compact.droppedCount });
  }

  const prompt = prepareAgentPrompt(
    stableSystem,
    opts.planMode ? PLAN_MODE_PROMPT : null,
    compactedHistory,
  );

  let stepsSeen = 0;
  return streamText({
    model,
    system: prompt.system,
    messages: prompt.messages,
    allowSystemInMessages: false,
    tools: buildTools(opts.toolContext),
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    abortSignal: opts.abortSignal,
    onStepFinish: (step) => {
      stepsSeen++;
      if (opts.onStep) {
        const last = step.toolCalls?.[step.toolCalls.length - 1];
        if (last) {
          const label = TOOL_LABELS[last.toolName];
          opts.onStep(
            label
              ? label((last.input ?? {}) as Record<string, unknown>)
              : `Calling ${last.toolName}`,
          );
        } else if (step.text) {
          opts.onStep("Writing");
        }
      }
      if (opts.onUsage && step.usage) {
        const u = step.usage;
        const stepInput = u.inputTokens ?? 0;
        const stepCached = u.inputTokenDetails?.cacheReadTokens ?? 0;
        opts.onUsage({
          inputTokens: stepInput,
          outputTokens: u.outputTokens ?? 0,
          cachedInputTokens: stepCached,
          lastInputTokens: stepInput,
          lastCachedTokens: stepCached,
        });
      }
    },
    onFinish: (result) => {
      opts.onStep?.(null);
      const finishReason =
        (result as { finishReason?: string } | undefined)?.finishReason ?? "";
      opts.onFinishMeta?.({
        hitStepCap: stepsSeen >= MAX_AGENT_STEPS,
        finishReason,
      });
    },
  });
}

export { EMPTY_USAGE };
