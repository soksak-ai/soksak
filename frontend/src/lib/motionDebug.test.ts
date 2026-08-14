// Motion observation — pin the effect, not the setting.
//
// RED basis (incident 2026-07-26): the first version only set the --motion-scale custom property on :root.
// Reading the state returned 20 and the command answered 20, but no declaration consumed that variable, so
// the screen did not slow down at all. "The setting was applied" stood in for "it got slower" — the same
// substitution that was the problem all day. So what is asserted here is the real animation's playbackRate.
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetMotionDebugForTest,
  applyMotionTo,
  motionDebugState,
  setMotionDebug,
  type Retimable,
} from "./motionDebug";

// jsdom has no Web Animations. The browser's playbackRate implementation is not ours, so it is not tested
// here — the responsibility here is "which value, and when it is taken", and that is asserted directly.
function fake(): Retimable & { paused: boolean } {
  return {
    playbackRate: 1,
    paused: false,
    get playState() {
      return this.paused ? "paused" : "running";
    },
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
    },
  };
}

describe("motionDebug — a claim of slower must be an actual speed", () => {
  beforeEach(() => {
    __resetMotionDebugForTest();
    document.body.innerHTML = "";
  });

  it("a higher factor lowers the animation speed by its reciprocal", () => {
    setMotionDebug({ scale: 20 });
    const a = fake();
    applyMotionTo(a);
    expect(a.playbackRate).toBeCloseTo(1 / 20);
  });

  it("setting the factor back to 1 restores the normal speed", () => {
    setMotionDebug({ scale: 50 });
    const a = fake();
    applyMotionTo(a);
    expect(a.playbackRate).toBeCloseTo(1 / 50);
    setMotionDebug({ scale: 1 });
    applyMotionTo(a);
    expect(a.playbackRate).toBe(1);
  });

  it("hold actually pauses, and releasing it resumes", () => {
    setMotionDebug({ hold: true });
    const a = fake();
    applyMotionTo(a);
    expect(a.playState).toBe("paused");
    setMotionDebug({ hold: false });
    applyMotionTo(a);
    expect(a.playState).not.toBe("paused");
  });

  it("there is one state — the value read is the value applied", () => {
    setMotionDebug({ scale: 5, hold: true });
    expect(motionDebugState()).toEqual({ scale: 5, hold: true });
  });

  it("an out-of-range factor is ignored — the state is not corrupted", () => {
    setMotionDebug({ scale: 20 });
    setMotionDebug({ scale: 0 });
    setMotionDebug({ scale: 9999 });
    expect(motionDebugState().scale).toBe(20);
  });
});
