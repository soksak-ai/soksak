// Phase-landing scheduling also goes through the motion controller.
//
// RED basis (user measurement, 2026-07-26): "it just won't stop" — the move finished even after
// pressing hold. playbackRate and pause only catch animations on the document timeline, but the
// phase landing was counted by setTimeout. The screen froze while the timer kept counting and then
// declared the landing, so the observation tool erased the very moment under inspection. This pins
// down that the schedule runs on the same timeline.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMotionDebugForTest,
  scheduleMotion,
  scheduleMotionAtUnixUs,
  setMotionDebug,
} from "./motionDebug";
import { presentationNowUnixUs } from "./presentationClock";

class FakeEffect {
  constructor(
    public target: unknown,
    public frames: unknown,
    public timing: { duration: number },
  ) {}
  getComputedTiming() {
    return { duration: this.timing.duration, progress: 0 };
  }
}
class FakeAnimation {
  static made: FakeAnimation[] = [];
  id = "";
  playbackRate = 1;
  playState = "idle";
  onfinish: (() => void) | null = null;
  paused = false;
  constructor(public effect: FakeEffect) {
    FakeAnimation.made.push(this);
  }
  play() {
    this.playState = "running";
    this.paused = false;
  }
  pause() {
    this.playState = "paused";
    this.paused = true;
  }
  cancel() {
    this.playState = "idle";
  }
  /** Land after the time the screen actually uses */
  finish() {
    this.onfinish?.();
  }
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown> = {};

beforeEach(() => {
  __resetMotionDebugForTest();
  FakeAnimation.made = [];
  saved = { Animation: g.Animation, KeyframeEffect: g.KeyframeEffect };
  g.Animation = FakeAnimation;
  g.KeyframeEffect = FakeEffect;
  Object.defineProperty(document, "timeline", { value: {}, configurable: true });
});
afterEach(() => {
  g.Animation = saved.Animation;
  g.KeyframeEffect = saved.KeyframeEffect;
});

describe("scheduleMotion — a schedule runs on the same clock as the screen", () => {
  it("an absolute shared epoch delays arming without shortening the motion", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const done = vi.fn();
    scheduleMotionAtUnixUs(presentationNowUnixUs() + 100_000, 340, done);
    vi.advanceTimersByTime(340);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("keeps the declared duration — a caller that multiplies by the scale doubles it", () => {
    setMotionDebug({ scale: 20 });
    scheduleMotion(340, () => {});
    expect(FakeAnimation.made[0].effect.timing.duration).toBe(340);
  });

  it("applies the scale as playback rate — the same axis as a screen transition", () => {
    setMotionDebug({ scale: 20 });
    scheduleMotion(340, () => {});
    expect(FakeAnimation.made[0].playbackRate).toBe(1 / 20);
  });

  it("a held motion holds its schedule — a landing does not erase the frozen moment", () => {
    setMotionDebug({ hold: true });
    const done = vi.fn();
    scheduleMotion(340, done);
    expect(FakeAnimation.made[0].paused).toBe(true);
    expect(done).not.toHaveBeenCalled();
  });

  it("leaves the timeline untouched by default — an observation tool does not change production", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleMotion(340, done);
    expect(FakeAnimation.made).toHaveLength(0);
    vi.advanceTimersByTime(340);
    expect(done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("a hold pressed mid-motion applies to that motion — the remainder moves to the timeline", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleMotion(340, done);
    expect(FakeAnimation.made).toHaveLength(0); // normal path — a timer runs it
    setMotionDebug({ hold: true });
    expect(FakeAnimation.made).toHaveLength(1); // observation turns on and the schedule moves
    expect(FakeAnimation.made[0].paused).toBe(true);
    vi.advanceTimersByTime(10_000); // it moved, so the old timer no longer lands it
    expect(done).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a moved schedule keeps only the remaining duration — it does not restart", () => {
    vi.useFakeTimers();
    const started = performance.now();
    scheduleMotion(340, () => {});
    vi.advanceTimersByTime(170);
    vi.setSystemTime(new Date(Date.now() + 170));
    setMotionDebug({ scale: 20 });
    const left = FakeAnimation.made[0].effect.timing.duration;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(340);
    expect(performance.now()).toBeGreaterThanOrEqual(started);
    vi.useRealTimers();
  });

  it("a cancelled schedule never calls back — under observation (timeline)", () => {
    setMotionDebug({ scale: 20 });
    const done = vi.fn();
    scheduleMotion(340, done)();
    FakeAnimation.made[0].finish();
    expect(done).not.toHaveBeenCalled();
  });

  it("a cancelled schedule never calls back — normal path (timer). No ghost landing when the phase swaps", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    scheduleMotion(340, done)();
    vi.advanceTimersByTime(10_000);
    expect(done).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("zero on the phase clock is the moment the screen started to move", () => {
  // RED basis (measured, 2026-07-26): the schedule starts counting in a React effect, but the screen
  // moves after the next paint. Normal skew is 5~44ms (up to 13% of 340ms) — the landing is declared
  // with that much of the glide tail cut off. When the screen reports its first movement, push the
  // schedule back by that amount so the two zeros line up.
  it("the landing is pushed back by however late the first movement was", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const done = vi.fn();
    scheduleMotion(340, done);
    vi.advanceTimersByTime(40); // the screen has not moved yet
    document.dispatchEvent(new Event("animationstart", { bubbles: true }));
    vi.advanceTimersByTime(300); // the original schedule would have landed here
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60); // the place it was pushed back to by the skew
    expect(done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
