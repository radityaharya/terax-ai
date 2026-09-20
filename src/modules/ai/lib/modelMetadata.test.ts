import { describe, expect, it } from "vitest";
import { detectProviderId, inferLab } from "./modelMetadata";

describe("inferLab", () => {
  it("maps well-known model families to their lab", () => {
    expect(inferLab("claude-sonnet", "claude-sonnet-5")).toBe("anthropic");
    expect(inferLab("gpt-codex", "gpt-5.3-codex")).toBe("openai");
    expect(inferLab("gemini-pro", "gemini-3.1-pro-preview")).toBe("google");
    expect(inferLab("grok", "grok-4.5")).toBe("xai");
    expect(inferLab("deepseek", "deepseek-v4-pro")).toBe("deepseek");
    expect(inferLab("kimi-k3", "chutes/kimi-k3")).toBe("moonshotai");
    expect(inferLab("llama", "llama-3.3-70b")).toBe("meta");
    expect(inferLab("qwen3.6", "qwen3.6-max")).toBe("qwen");
    expect(inferLab("glm", "glm-4.6")).toBe("zai");
    expect(inferLab("mistral-large", "mistral-large-latest")).toBe("mistral");
    expect(inferLab("gpt-oss", "gpt-oss-120b")).toBe("openai");
  });

  it("falls back to the model id when family is missing", () => {
    expect(inferLab(undefined, "claude-opus-4-8")).toBe("anthropic");
    expect(inferLab(undefined, "o3-mini")).toBe("openai");
    expect(inferLab(undefined, "yi-lightning")).toBe("01-ai");
  });

  it("returns null for unknown brands instead of guessing", () => {
    expect(inferLab("morph", "morph-v3")).toBeNull();
    expect(inferLab("laguna", "laguna-s")).toBeNull();
    expect(inferLab(undefined, "some-random-model")).toBeNull();
  });
});

describe("detectProviderId", () => {
  it("detects known API hosts", () => {
    expect(detectProviderId("https://api.openai.com/v1")).toBe("openai");
    expect(detectProviderId("https://api.anthropic.com/v1")).toBe("anthropic");
    expect(detectProviderId("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(detectProviderId("https://api.deepseek.com")).toBe("deepseek");
  });

  it("treats local and unknown hosts as unattributed", () => {
    expect(detectProviderId("http://localhost:1234/v1")).toBeNull();
    expect(detectProviderId("https://cliproxy.rdt.fyi/v1")).toBeNull();
    expect(detectProviderId("not a url")).toBeNull();
  });
});
