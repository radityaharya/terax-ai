import { describe, expect, it } from "vitest";
import {
  HOST_COLOR_PALETTE,
  hostChipStyle,
  hostDotStyle,
  hostIdSeed,
  normalizeHostColor,
  resolveHostColor,
  suggestHostColor,
} from "./hostColor";

describe("normalizeHostColor", () => {
  it("accepts 6-digit hex with or without the hash", () => {
    expect(normalizeHostColor("#4F8FF7")).toBe("#4f8ff7");
    expect(normalizeHostColor("4f8ff7")).toBe("#4f8ff7");
  });

  it("expands 3-digit shorthand", () => {
    expect(normalizeHostColor("#0a0")).toBe("#00aa00");
    expect(normalizeHostColor("abc")).toBe("#aabbcc");
  });

  it("treats blank as auto (null)", () => {
    expect(normalizeHostColor(null)).toBeNull();
    expect(normalizeHostColor(undefined)).toBeNull();
    expect(normalizeHostColor("   ")).toBeNull();
  });

  it("rejects anything that is not hex", () => {
    for (const bad of ["red", "#12345", "#zzzzzz", "rgb(1,2,3)", "url(x)"]) {
      expect(normalizeHostColor(bad), bad).toBeNull();
    }
  });
});

describe("suggestHostColor", () => {
  it("is deterministic for the same seed", () => {
    expect(suggestHostColor("prod-arena")).toBe(suggestHostColor("prod-arena"));
  });

  it("always returns a palette entry", () => {
    const hexes = new Set(HOST_COLOR_PALETTE.map((c) => c.hex));
    for (const seed of ["a", "b", "", "217.216.74.111", "itdev"]) {
      expect(hexes.has(suggestHostColor(seed))).toBe(true);
    }
  });

  it("spreads nearby seeds across the palette", () => {
    const picked = new Set(
      ["host-1", "host-2", "host-3", "host-4", "host-5"].map(suggestHostColor),
    );
    expect(picked.size).toBeGreaterThan(1);
  });
});

describe("hostIdSeed", () => {
  // Must stay byte-for-byte in step with the Rust `host_id_for` used to mint
  // a new host's id, or the editor's Auto preview would promise one color and
  // the saved host would show another.
  it("matches the Rust host_id_for vectors", () => {
    expect(hostIdSeed("Prod Web 01!")).toBe("prod web 01");
    expect(hostIdSeed("..evil..")).toBe("evil");
    expect(hostIdSeed("db.primary")).toBe("db.primary");
  });
});

describe("resolveHostColor", () => {
  it("prefers an explicit color over the auto suggestion", () => {
    expect(resolveHostColor({ id: "prod", color: "#4f8ff7" })).toBe("#4f8ff7");
  });

  it("falls back to the id-seeded suggestion when unset or invalid", () => {
    const auto = suggestHostColor("prod");
    expect(resolveHostColor({ id: "prod", color: null })).toBe(auto);
    expect(resolveHostColor({ id: "prod", color: "not-a-color" })).toBe(auto);
  });

  it("uses the alias when there is no id", () => {
    expect(resolveHostColor({ alias: "web" })).toBe(suggestHostColor("web"));
  });
});

describe("style helpers", () => {
  it("paints the dot with the raw accent", () => {
    expect(hostDotStyle("#4f8ff7")).toEqual({ backgroundColor: "#4f8ff7" });
  });

  it("tints the chip with color-mix and keeps the accent as ink", () => {
    const style = hostChipStyle("#4f8ff7");
    expect(style.color).toBe("#4f8ff7");
    expect(style.backgroundColor).toContain("color-mix(in oklab");
    expect(style.borderColor).toContain("color-mix(in oklab");
  });
});
