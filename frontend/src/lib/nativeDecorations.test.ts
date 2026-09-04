// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetNativeDecorationsForTest,
  cssColorRGBA,
  nativeDecorationFacts,
  replaceNativeDecorations,
  setNativeDecorationOverlays,
  setNativeDecorationPresentationVisible,
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

  // An overlay that covers a corner of one card is not a reason to take every card border off the
  // screen. Measured 2026-09-04: opening the program menu removed the perimeter from every pane in
  // the window for as long as it was open.
  it("withholds only the decorations an overlay covers", async () => {
    const blue = cssColorRGBA("#5aa2ff")!;
    replaceNativeDecorations("card", [
      strokeDecoration("card/left", "M 0 0 L 100 0 L 100 100 L 0 100 Z", blue, 1),
      strokeDecoration("card/right", "M 300 0 L 400 0 L 400 100 L 300 100 Z", blue, 1),
    ]);
    await Promise.resolve();
    await Promise.resolve();

    setNativeDecorationOverlays([{ left: 40, top: 40, right: 140, bottom: 90 }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeDecorationFacts()).toMatchObject({
      presentedDecorations: [{ id: "card/right" }],
      receipt: { count: 1 },
    });

    setNativeDecorationOverlays([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeDecorationFacts().presentedDecorations.map((one) => one.id))
      .toEqual(["card/left", "card/right"]);
  });

  // An overlay that does not say what it covers covers the window. A modal is one, and taking every
  // decoration off is what it needs.
  it("withholds every decoration for an overlay that names no area", async () => {
    const blue = cssColorRGBA("#5aa2ff")!;
    replaceNativeDecorations("card", [
      strokeDecoration("card/left", "M 0 0 L 100 0 L 100 100 L 0 100 Z", blue, 1),
    ]);
    await Promise.resolve();
    await Promise.resolve();

    setNativeDecorationOverlays([null]);
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeDecorationFacts()).toMatchObject({
      presentedDecorations: [],
      receipt: { count: 0 },
    });
  });

  it("keeps declarations but applies an empty native plane while a DOM overlay owns presentation", async () => {
    const blue = cssColorRGBA("#5aa2ff")!;
    replaceNativeDecorations("focus", [
      strokeDecoration("focus/a", "M 0 0 L 1 1", blue, 1),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeDecorationFacts()).toMatchObject({
      presentationVisible: true,
      decorations: [{ id: "focus/a" }],
      receipt: { count: 1 },
    });

    setNativeDecorationPresentationVisible(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeDecorationFacts()).toMatchObject({
      presentationVisible: false,
      decorations: [{ id: "focus/a" }],
      presentedDecorations: [],
      receipt: { count: 0 },
    });

    setNativeDecorationPresentationVisible(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeDecorationFacts()).toMatchObject({
      presentationVisible: true,
      decorations: [{ id: "focus/a" }],
      presentedDecorations: [{ id: "focus/a" }],
      receipt: { count: 1 },
    });
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
