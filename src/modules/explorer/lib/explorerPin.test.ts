import { describe, expect, it } from "vitest";
import { activePin } from "./explorerPin";

describe("activePin", () => {
  it("returns null when nothing is pinned", () => {
    expect(activePin({ root: null, hostId: null }, null)).toBeNull();
    expect(activePin({ root: null, hostId: null }, "h1")).toBeNull();
  });

  it("returns the pin on the matching host", () => {
    expect(activePin({ root: "/home/u/proj", hostId: "h1" }, "h1")).toBe(
      "/home/u/proj",
    );
    expect(activePin({ root: "C:/work", hostId: null }, null)).toBe("C:/work");
  });

  it("ignores a pin from another host", () => {
    expect(activePin({ root: "/home/u/proj", hostId: "h1" }, "h2")).toBeNull();
    expect(activePin({ root: "/home/u/proj", hostId: "h1" }, null)).toBeNull();
    expect(activePin({ root: "C:/work", hostId: null }, "h1")).toBeNull();
  });
});
