import { describe, expect, it } from "vitest";
import { cellCarriesOwnDim } from "./parkedDim";

describe("a cell that carries its own dim", () => {
  it("carries it when the tab it is showing left a picture", () => {
    expect(cellCarriesOwnDim("tab-a", new Set(["tab-a"]))).toBe(true);
  });

  // A picture held for a tab the cell is not showing is no reading of what is on screen. Taking
  // the veil off for it left the pane with no veil and no picture, and its content disappeared —
  // measured 2026-09-04 with the program menu open.
  it("does not carry it when the picture belongs to a tab it is not showing", () => {
    expect(cellCarriesOwnDim("tab-a", new Set(["tab-b"]))).toBe(false);
  });

  it("does not carry it when it shows no tab", () => {
    expect(cellCarriesOwnDim(null, new Set(["tab-a"]))).toBe(false);
  });
});
