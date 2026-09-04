import { describe, expect, it } from "vitest";
import { DEFAULT_RAIL_PLACEMENT, isRailPlacement } from "./railPlacement";

// A placement is how the rail behaves when focus moves. Where it stands is on the space's plane
// (state/panePlane), so a stored station is not a placement this build reads.
describe("rail placement", () => {
  it("is flow by default", () => {
    expect(DEFAULT_RAIL_PLACEMENT).toEqual({ mode: "flow" });
  });

  it("is one of two modes and nothing else", () => {
    expect(isRailPlacement({ mode: "flow" })).toBe(true);
    expect(isRailPlacement({ mode: "pin" })).toBe(true);
    expect(isRailPlacement({ mode: "pin", station: 50 })).toBe(false);
    expect(isRailPlacement({ mode: "float" })).toBe(false);
    expect(isRailPlacement(undefined)).toBe(false);
    expect(isRailPlacement(null)).toBe(false);
    expect(isRailPlacement("flow")).toBe(false);
  });
});
