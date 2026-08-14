import { describe, expect, it } from "vitest";

import { claimDividerPointer, ratioFromPointer } from "./splitDrag";

describe("split divider pointer projection", () => {
  const rect = { left: 100, top: 200, width: 800, height: 600 };

  it("projects row dividers from the horizontal pointer coordinate", () => {
    expect(ratioFromPointer("row", rect, 700, 999)).toBe(0.75);
  });

  it("projects column dividers from the vertical pointer coordinate", () => {
    expect(ratioFromPointer("column", rect, 999, 350)).toBe(0.25);
  });

  it("claims only the divider pointer stream so it cannot start surrounding text selection", () => {
    const calls: string[] = [];
    claimDividerPointer({
      preventDefault: () => calls.push("default"),
      stopPropagation: () => calls.push("propagation"),
    });
    expect(calls).toEqual(["default", "propagation"]);
  });
});
