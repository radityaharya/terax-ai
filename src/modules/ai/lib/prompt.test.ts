import { streamText, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { prepareAgentPrompt } from "./prompt";

const history: ModelMessage[] = [
  { role: "user", content: "Fix the issue" },
  { role: "assistant", content: "I will inspect it." },
];

describe("prepareAgentPrompt", () => {
  it("keeps trusted instructions outside conversation messages", () => {
    const prompt = prepareAgentPrompt(
      "Stable instructions",
      "Plan instructions",
      history,
    );

    expect(prompt.system).toEqual([
      { role: "system", content: "Stable instructions" },
      { role: "system", content: "Plan instructions" },
    ]);
    expect(prompt.messages).toEqual(history);
    expect(prompt.messages.every((message) => message.role !== "system")).toBe(
      true,
    );
    expect(prompt.messages.every((m) => m.providerOptions == null)).toBe(true);
  });

  it("does not trigger the SDK system-message warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new MockLanguageModelV3({
      doStream: {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.close();
          },
        }),
      },
    });
    const prompt = prepareAgentPrompt(
      "Stable instructions",
      "Plan instructions",
      history,
    );

    try {
      const result = streamText({
        model,
        system: prompt.system,
        messages: prompt.messages,
        allowSystemInMessages: false,
        onError: () => {},
      });
      await result.consumeStream();
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("System messages in the prompt"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
