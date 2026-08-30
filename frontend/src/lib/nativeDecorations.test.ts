// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetNativeDecorationsForTest,
  cssColorRGBA,
  nativeDecorationFacts,
  replaceNativeDecorations,
  strokeDecoration,
} from "./nativeDecorations";

describe("native decoration inventory", () => {
  beforeEach(() => __resetNativeDecorationsForTest());
  afterEach(() => __resetNativeDecorationsForTest());

  it("coalesces component owners into one deterministic full snapshot", async () => {
    const blue = cssColorRGBA("#5aa2ff")!;
    replaceNativeDecorations("relation", [
      strokeDecoration("relation/z", "M 10 10 L 20 10", blue, 1.5, [4, 4]),
    ]);
    replaceNativeDecorations("focus", [
      strokeDecoration("focus/a", "M 0 0 L 4 0 L 4 4 L 0 4 Z", blue, 1),
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeDecorationFacts()).toMatchObject({
      decorations: [
        { id: "focus/a", path: "M 0 0 L 4 0 L 4 4 L 0 4 Z" },
        { id: "relation/z", path: "M 10 10 L 20 10", dash: [4, 4] },
      ],
      receipt: { count: 2, supported: false, layer: "dom-only" },
      error: null,
    });
  });

  it("replacing one owner removes only that owner's strokes", async () => {
    const blue = cssColorRGBA("rgb(90, 162, 255)")!;
    replaceNativeDecorations("focus", [
      strokeDecoration("focus/a", "M 0 0 L 1 1", blue, 1),
    ]);
    replaceNativeDecorations("relation", [
      strokeDecoration("relation/a", "M 2 2 L 3 3", blue, 1),
    ]);
    replaceNativeDecorations("focus", []);
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeDecorationFacts().decorations.map(({ id }) => id)).toEqual(["relation/a"]);
  });

  it("converts theme colors into numeric sRGB channels", () => {
    expect(cssColorRGBA("#5aa2ff")).toEqual({
      r: 90 / 255, g: 162 / 255, b: 1, a: 1,
    });
    expect(cssColorRGBA("rgba(21, 22, 30, 0.5)")).toEqual({
      r: 21 / 255, g: 22 / 255, b: 30 / 255, a: 0.5,
    });
  });
});
