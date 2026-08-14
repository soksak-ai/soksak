import { describe, expect, it } from "vitest";
import { flowRailBoundBox } from "./railBoundBox";

/** The narrow case and the wide case are two solutions of one formula — no mode branch. */
describe("border box — from the rail to the far edge of the bound pane", () => {
  it("a bound pane next to the rail makes the box the pane itself (narrow case)", () => {
    expect(flowRailBoundBox(0, { left: 0, top: 0, width: 50, height: 100 })).toEqual({
      left: 0,
      top: 0,
      width: 50,
      height: 100,
    });
  });

  it("another pane in between is taken into the box (wide case)", () => {
    expect(flowRailBoundBox(0, { left: 50, top: 0, width: 50, height: 50 })).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 50,
    });
  });

  it("a rail standing between panes is measured from where it is", () => {
    expect(flowRailBoundBox(25, { left: 50, top: 0, width: 50, height: 100 })).toEqual({
      left: 25,
      top: 0,
      width: 75,
      height: 100,
    });
  });

  it("a bound pane before (left of) a pinned rail joins into one box from the pane left edge to the rail", () => {
    expect(flowRailBoundBox(60, { left: 0, top: 0, width: 30, height: 100 })).toEqual({
      left: 0,
      top: 0,
      width: 60,
      height: 100,
    });
  });
});
