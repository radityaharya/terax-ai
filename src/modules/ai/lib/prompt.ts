import type { ModelMessage, SystemModelMessage } from "ai";

export type PreparedAgentPrompt = {
  system: SystemModelMessage[];
  messages: ModelMessage[];
};

export function prepareAgentPrompt(
  stableSystem: string,
  planInstructions: string | null,
  history: readonly ModelMessage[],
): PreparedAgentPrompt {
  const system: SystemModelMessage[] = [
    { role: "system", content: stableSystem },
  ];
  if (planInstructions) {
    system.push({ role: "system", content: planInstructions });
  }
  return { system, messages: history.slice() };
}
