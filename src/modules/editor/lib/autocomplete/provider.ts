import {
  modelSupportsTemperature,
  modelUsesReasoningTokens,
} from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { lookupModelMetadata } from "@/modules/ai/lib/modelMetadata";
import { generateText } from "ai";
import {
  buildUserPrompt,
  COMPLETION_SYSTEM_PROMPT,
  type CompletionRequest,
} from "./prompt";

export type CompletionDeps = {
  baseURL: string;
  modelId: string;
  apiKey: string | null;
};

const MAX_OUTPUT_TOKENS_DEFAULT = 128;
// Reasoning models burn output tokens on internal thought before producing
// any visible content; with a tight cap they finish_reason="length" with
// empty text. The trim step still caps visible output at MAX_LINES.
const MAX_OUTPUT_TOKENS_REASONING = 1024;

export async function requestCompletion(
  req: CompletionRequest,
  deps: CompletionDeps,
  signal: AbortSignal,
): Promise<string> {
  const modelId = deps.modelId.trim();
  if (!deps.baseURL.trim()) {
    throw new Error("No autocomplete endpoint configured.");
  }
  if (!modelId) {
    throw new Error("No autocomplete model selected.");
  }
  const model = await buildLanguageModel(deps.baseURL, deps.apiKey, modelId);

  const meta = lookupModelMetadata(deps.baseURL, modelId);
  const isReasoning = modelUsesReasoningTokens(
    modelId,
    meta ? { reasoning: meta.reasoning } : undefined,
  );

  const { text } = await generateText({
    model,
    system: COMPLETION_SYSTEM_PROMPT,
    prompt: buildUserPrompt(req),
    maxOutputTokens: isReasoning
      ? MAX_OUTPUT_TOKENS_REASONING
      : MAX_OUTPUT_TOKENS_DEFAULT,
    maxRetries: 0,
    abortSignal: signal,
    ...(modelSupportsTemperature(
      modelId,
      meta ? { supportsTemperature: meta.temperature } : undefined,
    )
      ? { temperature: 0.1 }
      : {}),
  });

  return cleanCompletion(text);
}

function cleanCompletion(raw: string): string {
  let t = raw;
  const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) t = fence[1];
  t = t.replace(/^<\|cursor\|>/, "");
  return t;
}
