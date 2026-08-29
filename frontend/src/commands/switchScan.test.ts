import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { classifySwitchFrames } from "./switchScan";
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

describe("switch scan command contract", () => {
  const source = readFileSync(resolve(import.meta.dirname, "catalog.ts"), "utf8");
  const space = source.split('register("space.switchScan"')[1]?.split('register("space.rename"')[0] ?? "";

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
});
