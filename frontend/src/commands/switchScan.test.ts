import { describe, expect, it } from "vitest";

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
});
