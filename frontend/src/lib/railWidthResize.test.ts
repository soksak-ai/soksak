import { describe, expect, it } from "vitest";
import { computeSplitLayout } from "./splitLayout";
import { railWidthResizePlan } from "./railWidthResize";
import type { SplitTree } from "../state/splitTree";

const layout: SplitTree<string> = {
  type: "split", id: "root", dir: "row", sizes: [0.46, 0.54],
  children: [{ type: "leaf", value: "left" }, { type: "leaf", value: "right" }],
};

describe("resizing an interior flow rail from its right grip", () => {
  it("keeps the physical left edge fixed and moves the right boundary by the full width delta", () => {
    const plan = railWidthResizePlan({
      gutters: computeSplitLayout(layout).gutters,
      startStation: 46,
      hostWidthPx: 1040,
      startWidthPx: 191,
      requestedWidthPx: 311,
    });

    expect(plan).not.toBeNull();
    expect(plan!.widthPx).toBeCloseTo(311, 6);
    expect(plan!.leftPx).toBeCloseTo((1040 - 191) * 0.46, 6);
    expect(plan!.rightPx - plan!.leftPx).toBeCloseTo(311, 6);
    // Only the two regions touching the dragged boundary change: the left tabview keeps its exact
    // physical width, rail gains 120px, and the right tabview loses the same 120px.
    const leftBefore = (1040 - 191) * 0.46;
    const rightBefore = 1040 - leftBefore - 191;
    expect(plan!.leftPx).toBeCloseTo(leftBefore, 6);
    expect(1040 - plan!.rightPx).toBeCloseTo(rightBefore - 120, 6);
    expect(plan!.station).toBeGreaterThan(46);
    expect(plan!.moves).toHaveLength(1);
    expect(plan!.moves[0].sizes[0]).toBeCloseTo(plan!.station / 100, 6);
  });
});
