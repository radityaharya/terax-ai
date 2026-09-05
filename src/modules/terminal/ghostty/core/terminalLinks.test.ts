import { expect, it } from "vitest";
import { detectTerminalLinks } from "./terminalLinks";

it("finds ordinary URLs without swallowing prose punctuation", () => {
  expect(
    detectTerminalLinks(
      "See (https://example.com/a_(b)). mailto:me@example.com",
    ).map((link) => link.uri),
  ).toEqual(["https://example.com/a_(b)", "mailto:me@example.com"]);
});
it("ignores executable protocols and incomplete links", () => {
  expect(
    detectTerminalLinks("javascript:alert(1) data:text/html,x https://"),
  ).toEqual([]);
});
it("preserves Unicode and query parameters with correct text offsets", () => {
  const text = "日本 https://example.com/日本?q=one&x=2 end";
  const [link] = detectTerminalLinks(text);
  expect(text.slice(link.start, link.end)).toBe(
    "https://example.com/日本?q=one&x=2",
  );
});
