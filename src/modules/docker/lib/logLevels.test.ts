import { describe, expect, it } from "vitest";
import {
  classifyLogLevel,
  extractTimestamp,
  stripTimestamp,
} from "./logLevels";

describe("classifyLogLevel", () => {
  it("buckets common level words", () => {
    expect(classifyLogLevel("ERROR something broke")).toBe("error");
    expect(classifyLogLevel("2026-09-20T09:15:32Z WARN retrying")).toBe("warn");
    expect(classifyLogLevel("[info] listening on :8080")).toBe("info");
    expect(classifyLogLevel("debug: cache miss")).toBe("debug");
    expect(classifyLogLevel("TRACE span opened")).toBe("trace");
    expect(classifyLogLevel("panic: runtime error")).toBe("error");
    expect(classifyLogLevel("Failed to connect")).toBe("error");
  });

  it("ignores ansi when classifying", () => {
    expect(classifyLogLevel("\u001b[31mERROR\u001b[0m boom")).toBe("error");
  });

  it("falls back to plain", () => {
    expect(classifyLogLevel("Saving data to: /data")).toBe("plain");
    expect(classifyLogLevel("")).toBe("plain");
  });
});

describe("extractTimestamp", () => {
  it("pulls ISO timestamps off the front", () => {
    expect(extractTimestamp("2026-09-20T09:15:32.896513192Z Saving data")).toBe(
      "2026-09-20T09:15:32.896513192Z",
    );
    expect(extractTimestamp("2026-09-20 09:15:32 hello")).toBe(
      "2026-09-20 09:15:32",
    );
  });

  it("returns null without a timestamp", () => {
    expect(extractTimestamp("Saving data to: /data")).toBeNull();
  });
});

describe("stripTimestamp", () => {
  it("removes the leading timestamp", () => {
    expect(stripTimestamp("2026-09-20T09:15:32Z Saving data to: /data")).toBe(
      "Saving data to: /data",
    );
  });

  it("leaves plain lines alone", () => {
    expect(stripTimestamp("Saving data to: /data")).toBe(
      "Saving data to: /data",
    );
  });
});
