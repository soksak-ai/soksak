import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeSurfacePicturePaint, nativeSurfacePicturePlacements } from "./captureNativeSurfaceComposition";

describe("capture-only native surface composition", () => {
  it("paints Core native decorations after every provider image", () => {
    const source = readFileSync(resolve(import.meta.dirname, "captureNativeSurfaceComposition.ts"), "utf8");
    const backgroundPaint = source.indexOf("context.fillStyle = background");
    const documentPaint = source.indexOf("context.drawImage(base, 0, 0)");
    const surfacePaint = source.indexOf("context.drawImage(\n      image,");
    const decorationPaint = source.indexOf("context.stroke(new Path2D(decoration.path))");
    expect(backgroundPaint).toBeGreaterThan(0);
    expect(documentPaint).toBeGreaterThan(backgroundPaint);
    expect(surfacePaint).toBeGreaterThan(0);
    expect(decorationPaint).toBeGreaterThan(surfacePaint);
  });

  it("paints the native picture opaquely and applies declared dim once above it", () => {
    expect(nativeSurfacePicturePaint(1)).toEqual({ pictureAlpha: 1, veilAlpha: 0 });
    expect(nativeSurfacePicturePaint(0.5)).toEqual({ pictureAlpha: 1, veilAlpha: 0.5 });
    expect(nativeSurfacePicturePaint(0)).toEqual({ pictureAlpha: 1, veilAlpha: 1 });
  });

  it("clips visible surfaces into the capture region and preserves layer order", () => {
    expect(nativeSurfacePicturePlacements(
      { x: 100, y: 50, w: 400, h: 300 },
      [
        { id: "hidden", x: 110, y: 60, w: 20, h: 20, visible: false, alpha: 1, layer: 0 },
        { id: "upper", x: 450, y: 300, w: 100, h: 100, visible: true, alpha: 0.5, layer: 10 },
        { id: "lower", x: 80, y: 40, w: 100, h: 80, visible: true, alpha: 1, layer: 0 },
        { id: "away", x: 700, y: 500, w: 10, h: 10, visible: true, alpha: 1, layer: 0 },
      ],
    )).toEqual([
      {
        id: "lower", alpha: 1,
        source: { x: 20, y: 10, w: 80, h: 70 },
        target: { x: 0, y: 0, w: 80, h: 70 },
      },
      {
        id: "upper", alpha: 0.5,
        source: { x: 0, y: 0, w: 50, h: 50 },
        target: { x: 350, y: 250, w: 50, h: 50 },
      },
    ]);
  });
});
