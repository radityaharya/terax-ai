import { expect, it } from "vitest";
import { homeRelativePath } from "@/lib/homeRelativePath";

it.each([
  ["C:\\Users\\me\\repo", "C:/Users/me/", "~/repo"],
  ["C:/Users/me", "C:\\Users\\me", "~"],
  ["/home/me/repo", "/home/me", "~/repo"],
  ["/home/other/repo", "/home/me", "/home/other/repo"],
  ["C:\\Users\\member", "C:/Users/me", "C:/Users/member"],
  ["D:\\repo", null, "D:/repo"],
])("formats %s relative to %s", (path, home, expected) => {
  expect(homeRelativePath(path, home)).toBe(expected);
});
