import { describe, expect, it } from "vitest";
import { surfaceRectOf, translatedSurfaceRectOf } from "./surfaceRect";

describe("surfaceRectOf", () => {
  it("folds fractional DOM edges inward onto an integer surface rect", () => {
    expect(surfaceRectOf({
      left: 59.75,
      top: 30,
      right: 441.25,
      bottom: 579,
    })).toEqual({ x: 60, y: 30, w: 381, h: 549 });
  });
});

describe("translatedSurfaceRectOf", () => {
  it("takes the fractional landing x for the glide target and keeps the source surface 381px wide", () => {
    const raw = {
      left: 220.25,
      top: 30,
      right: 601.25,
      bottom: 579,
    };

    expect(translatedSurfaceRectOf(raw, -160.5, { w: 381, h: 549 })).toEqual({
      x: 60,
      y: 30,
      w: 381,
      h: 549,
    });
  });
});
