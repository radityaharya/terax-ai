import { describe, expect, it } from "vitest";
import {
  computeCost,
  endpointIdForSelection,
  getModelContextLimit,
  isKnownModelId,
  isModelSelection,
  migrateLegacyCompatEndpoint,
  modelIdForSelection,
  modelKeepsReasoning,
  modelSelectionKey,
  modelSupportsTemperature,
  modelUsesReasoningTokens,
  parseModelSelectionKey,
  resolveModel,
  type CustomEndpoint,
} from "./config";

const endpoint: CustomEndpoint = {
  id: "ab12cd34",
  name: "My LLM",
  baseURL: "https://api.example.com/v1",
  contextLimit: 64_000,
};

describe("model selection keys", () => {
  it("round-trips endpoint + model", () => {
    const key = modelSelectionKey(endpoint.id, "llama-3.3-70b");
    expect(key).toBe("ab12cd34::llama-3.3-70b");
    expect(parseModelSelectionKey(key)).toEqual({
      endpointId: endpoint.id,
      modelId: "llama-3.3-70b",
    });
    expect(endpointIdForSelection(key)).toBe(endpoint.id);
    expect(modelIdForSelection(key)).toBe("llama-3.3-70b");
    expect(isModelSelection(key)).toBe(true);
  });

  it("rejects malformed keys", () => {
    expect(parseModelSelectionKey("nope")).toBeNull();
    expect(isModelSelection("nope")).toBe(false);
    expect(isModelSelection("ep::")).toBe(false);
    expect(endpointIdForSelection("")).toBe("");
    expect(modelIdForSelection("")).toBe("");
  });

  it("treats only empty and selection keys as known model ids", () => {
    expect(isKnownModelId("")).toBe(true);
    expect(isKnownModelId(modelSelectionKey("ep", "m"))).toBe(true);
    expect(isKnownModelId("gpt-5.4-mini")).toBe(false);
  });
});

describe("resolveModel", () => {
  it("resolves a selection against its endpoint", () => {
    const key = modelSelectionKey(endpoint.id, "llama-3.3-70b");
    const info = resolveModel(key, [endpoint]);
    expect(info.provider).toBe("openai-compatible");
    expect(info.id).toBe(key);
    expect(info.label).toBe("llama-3.3-70b");
  });

  it("never throws for an unknown endpoint", () => {
    const info = resolveModel(modelSelectionKey("missing", "m"), []);
    expect(info.provider).toBe("openai-compatible");
    expect(info.label).toBe("m");
  });
});

describe("getModelContextLimit", () => {
  it("prefers the catalog limit", () => {
    const key = modelSelectionKey(endpoint.id, "llama-3.3-70b");
    expect(getModelContextLimit(key, [endpoint], 200_000)).toBe(200_000);
  });

  it("falls back to the endpoint limit", () => {
    const key = modelSelectionKey(endpoint.id, "llama-3.3-70b");
    expect(getModelContextLimit(key, [endpoint])).toBe(64_000);
  });

  it("defaults to 128k when nothing is configured", () => {
    expect(getModelContextLimit(undefined)).toBe(128_000);
    expect(getModelContextLimit("")).toBe(128_000);
  });
});

describe("modelKeepsReasoning", () => {
  it("honours the models.dev reasoning hint", () => {
    const info = resolveModel(modelSelectionKey(endpoint.id, "m"), [endpoint]);
    expect(modelKeepsReasoning(info, false)).toBe(false);
    expect(modelKeepsReasoning(info, true)).toBe(true);
  });

  it("keeps reasoning for opaque endpoints when unknown", () => {
    const info = resolveModel(modelSelectionKey(endpoint.id, "m"), [endpoint]);
    expect(modelKeepsReasoning(info)).toBe(true);
  });
});

describe("model sampling capabilities", () => {
  it("prefers models.dev temperature / reasoning flags", () => {
    expect(
      modelSupportsTemperature("mystery", { supportsTemperature: false }),
    ).toBe(false);
    expect(
      modelSupportsTemperature("mystery", { supportsTemperature: true }),
    ).toBe(true);
    expect(modelUsesReasoningTokens("mystery", { reasoning: true })).toBe(true);
    expect(modelUsesReasoningTokens("mystery", { reasoning: false })).toBe(
      false,
    );
  });

  it("falls back to id heuristics without metadata", () => {
    expect(modelSupportsTemperature("gpt-5.6")).toBe(false);
    expect(modelSupportsTemperature("llama-3.3-70b")).toBe(true);
    expect(modelUsesReasoningTokens("deepseek-reasoner")).toBe(true);
    expect(modelUsesReasoningTokens("llama-3.3-70b")).toBe(false);
  });
});

describe("migrateLegacyCompatEndpoint", () => {
  it("returns the endpoint and the legacy model id", () => {
    const out = migrateLegacyCompatEndpoint(
      "https://api.example.com/v1",
      "llama-3.3-70b",
      32_000,
      "fixedid1",
    );
    expect(out).not.toBeNull();
    expect(out?.endpoint).toMatchObject({
      id: "fixedid1",
      baseURL: "https://api.example.com/v1",
      contextLimit: 32_000,
    });
    expect(out?.modelId).toBe("llama-3.3-70b");
  });

  it("skips migration when base URL or model id is missing", () => {
    expect(migrateLegacyCompatEndpoint("", "m", 1, "x")).toBeNull();
    expect(migrateLegacyCompatEndpoint("u", "  ", 1, "x")).toBeNull();
  });
});

describe("computeCost", () => {
  const usage = {
    inputTokens: 2_000_000,
    outputTokens: 1_000_000,
    cachedInputTokens: 500_000,
  };

  it("returns null without pricing", () => {
    expect(computeCost(null, usage)).toBeNull();
    expect(computeCost(undefined, usage)).toBeNull();
  });

  it("charges fresh tokens at input price and cached tokens at cache price", () => {
    expect(
      computeCost({ input: 5, output: 30, cacheRead: 0.5 }, usage),
    ).toBeCloseTo(37.75, 6);
  });

  it("falls back to the input price when no cache-read rate is set", () => {
    const grok = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 400_000,
    };
    expect(computeCost({ input: 3, output: 15 }, grok)).toBeCloseTo(3, 6);
  });

  it("never charges negative fresh tokens when cache exceeds input", () => {
    const over = { inputTokens: 100, outputTokens: 0, cachedInputTokens: 900 };
    expect(computeCost({ input: 5, output: 30 }, over)).toBeGreaterThanOrEqual(
      0,
    );
  });
});
