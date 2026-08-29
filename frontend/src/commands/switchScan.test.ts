import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { classifySwitchFrames, classifySwitchMotion } from "./switchScan";
import * as switchScan from "./switchScan";

describe("switch frame verdict", () => {
  it("accepts one pixel transition frame", () => {
    expect(classifySwitchFrames([0, 0.12, 0], 0.003)).toEqual({
      switchFrame: 1,
      switchFrames: 1,
      flickerFrames: 0,
      clean: true,
    });
  });

  it("rejects a transition spread over multiple frames", () => {
    expect(classifySwitchFrames([0, 0.12, 0.09, 0], 0.003)).toEqual({
      switchFrame: 1,
      switchFrames: 2,
      flickerFrames: 1,
      clean: false,
    });
  });

  it("does not invent a switch below the measured noise floor", () => {
    expect(classifySwitchFrames([0, 0.001, 0.002], 0.003)).toEqual({
      switchFrame: -1,
      switchFrames: 0,
      flickerFrames: 0,
      clean: false,
    });
  });

  it("ignores changed pixels below forty percent of the measured transition peak", () => {
    expect(classifySwitchFrames([0, 0.12, 0.01, 0], 0.003)).toEqual({
      switchFrame: 1,
      switchFrames: 1,
      flickerFrames: 0,
      clean: true,
    });
  });
});

describe("switch layout motion verdict", () => {
  it("accepts a glide only when every journey finishes", () => {
    expect(classifySwitchMotion([
      { at: "pane/a", end: "finish" },
      { at: "rail", end: "finish" },
    ], true)).toEqual({
      journeys: 2,
      cancelled: [],
      incomplete: [],
      clean: true,
    });
  });

  it("rejects cancelled, incomplete, and missing glide journeys", () => {
    expect(classifySwitchMotion([
      { at: "pane/a", end: "cancel" },
      { at: "rail", end: null },
    ], true)).toMatchObject({
      cancelled: ["pane/a"],
      incomplete: ["rail"],
      clean: false,
    });
    expect(classifySwitchMotion([], true).clean).toBe(false);
  });

  it("requires no journey for a non-layout tab switch", () => {
    expect(classifySwitchMotion([], false)).toMatchObject({ clean: true });
  });
});

describe("switch scan command contract", () => {
  const source = readFileSync(resolve(import.meta.dirname, "catalog.ts"), "utf8");
  const space = source.split('register("space.switchScan"')[1]?.split('register("space.rename"')[0] ?? "";
  const tab = source.split('register("tab.switchScan"')[1]?.split('register("tab.move"')[0] ?? "";

  it("uses recorded frames rather than elapsed-time activation", () => {
    expect(source).toContain("applyAtFrame");
    expect(space).toContain("...switchScanParams()");
    expect(space).not.toContain("applyAtMs");
    expect(space).not.toContain("settleMs");
    expect(space).not.toContain("setTimeout");
  });

  it("exposes tab scanning and numeric composition verdicts", () => {
    expect(source).toContain('register("tab.switchScan"');
    for (const field of ["blankFrames", "overlapFrames", "nativeMismatchFrames", "flickerFrames"]) {
      expect(source).toContain(field);
    }
  });

  it("settles the precondition through the event-driven presentation barrier", () => {
    const activation = source.split("const activateForSwitchScan")[1]
      ?.split("const visibleSpaceViews")[0] ?? "";
    expect(activation).toContain("await waitLayoutSettled(15_000)");
    expect(activation).not.toContain("setTimeout");
  });

  it("reports a clean glide as completed journeys rather than a one-frame snap", () => {
    expect(tab).toContain('transaction?.mode === "glide"');
    expect(tab).toContain('msg.tab.switchScan.cleanGlide');
    expect(space).toContain('msg.space.switchScan.cleanGlide');
  });
});

describe("switch presentation verdict", () => {
  type View = {
    native: boolean;
    contentVisible: boolean;
    surfaceVisible: boolean;
    liveSurfaceVisible: boolean;
    parkedPictureVisible: boolean;
  };
  const view = (over: Partial<View>): View => ({
    native: false,
    contentVisible: false,
    surfaceVisible: false,
    liveSurfaceVisible: false,
    parkedPictureVisible: false,
    ...over,
  });
  const classify = (switchScan as unknown as {
    classifySwitchPresentation?: (
      samples: Array<{ frame: number; from: View; to: View }>,
    ) => Record<string, unknown>;
  }).classifySwitchPresentation;

  it("counts blank, overlap, and native receipt mismatch frames", () => {
    expect(classify).toBeTypeOf("function");
    if (!classify) return;
    const result = classify([
      { frame: 0, from: view({ contentVisible: true }), to: view({}) },
      { frame: 1, from: view({}), to: view({}) },
      { frame: 2, from: view({ contentVisible: true }), to: view({ contentVisible: true }) },
      {
        frame: 3,
        from: view({}),
        to: view({ native: true, contentVisible: true, surfaceVisible: true }),
      },
      {
        frame: 4,
        from: view({}),
        to: view({ native: true, contentVisible: true, surfaceVisible: false, parkedPictureVisible: true }),
      },
    ]);
    expect(result).toMatchObject({
      blankFrames: [1, 3],
      overlapFrames: [2],
      nativeMismatchFrames: [3],
      clean: false,
    });
  });

  it("counts a departing parked picture over the arriving view as overlap", () => {
    expect(classify).toBeTypeOf("function");
    if (!classify) return;
    const result = classify([
      {
        frame: 7,
        from: view({ native: true, parkedPictureVisible: true }),
        to: view({ native: true, contentVisible: true, parkedPictureVisible: true }),
      },
    ]);
    expect(result).toMatchObject({ overlapFrames: [7], clean: false });
  });

  it("counts a departing live receipt as visible until the compositor hides it", () => {
    expect(classify).toBeTypeOf("function");
    if (!classify) return;
    const result = classify([
      {
        frame: 8,
        from: view({ native: true, liveSurfaceVisible: true }),
        to: view({ native: true, contentVisible: true, surfaceVisible: true }),
      },
    ]);
    expect(result).toMatchObject({
      blankFrames: [],
      overlapFrames: [],
      nativeMismatchFrames: [8],
      clean: false,
    });
  });
});
