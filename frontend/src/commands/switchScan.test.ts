import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { classifySwitchFrames } from "./switchScan";

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
    expect(space).toContain("applyAtFrame");
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
