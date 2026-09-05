import { expect, it } from "vitest";
import { changedTerminalText } from "./accessibleTerminalText";

it("announces appended output without repeating existing lines", () => {
  expect(changedTerminalText("first\nsecond", "first\nsecond\nthird")).toBe(
    "\nthird",
  );
  expect(changedTerminalText("first\nsecond", "second\nthird")).toBe("third");
  expect(changedTerminalText("same", "same")).toBe("");
});
it("bounds announcements during full-screen redraws", () => {
  expect(
    changedTerminalText("old", "new".repeat(10_000)).length,
  ).toBeLessThanOrEqual(2048);
});
