// The rail card owns one consistent two-edge perimeter in every look, theme
// and station. Position is the only changing axis.
import { describe, expect, it } from "vitest";
import { railEdgeWidths } from "./railEdges";

describe("railEdgeWidths", () => {
  it("owns both sides at every station and pane style", () => {
    expect(railEdgeWidths("ground", true, 0, "card")).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("ground", true, 100, "floating")).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("pane", true, 50, "flat")).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("pane", true, 0, "card")).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("pane", true, 100, "flat")).toEqual({ left: 1, right: 1 });
  });

  it("closed: 0 on both sides regardless of mode and theme", () => {
    expect(railEdgeWidths("pane", false, 50, "flat")).toEqual({ left: 0, right: 0 });
    expect(railEdgeWidths("ground", false, 50, "card")).toEqual({ left: 0, right: 0 });
  });
});
