// The rail card owns one consistent two-edge perimeter in every look, theme
// and station. Position is the only changing axis.
import { describe, expect, it } from "vitest";
import { railEdgeWidths } from "./railEdges";

describe("railEdgeWidths", () => {
  it("owns the complete card perimeter at every station and pane style", () => {
    expect(railEdgeWidths("ground", true, 0, "card")).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
    expect(railEdgeWidths("ground", true, 100, "floating")).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
    expect(railEdgeWidths("pane", true, 50, "flat")).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
    expect(railEdgeWidths("pane", true, 0, "card")).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
    expect(railEdgeWidths("pane", true, 100, "flat")).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
  });

  it("closed: 0 on every edge regardless of mode and theme", () => {
    expect(railEdgeWidths("pane", false, 50, "flat")).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(railEdgeWidths("ground", false, 50, "card")).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});
