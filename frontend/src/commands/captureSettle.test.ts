// @vitest-environment jsdom
// Capture settle contract — window.snapshot must produce the exact final frame even in a background
// window (stopped timeline): settle only finite-iteration animations to their end state, leave infinite ones untouched.
import { describe, it, expect } from "vitest";
import { isFiniteAnimation, settleAnimationsForCapture } from "./captureSettle";

describe("isFiniteAnimation", () => {
  it("finite iterations are true, infinite and undefined are false", () => {
    expect(isFiniteAnimation(1)).toBe(true);
    expect(isFiniteAnimation(3)).toBe(true);
    expect(isFiniteAnimation(Infinity)).toBe(false);
    expect(isFiniteAnimation(undefined)).toBe(false);
  });
});

type FakeAnim = { id: string; effect: { getComputedTiming: () => { iterations: number } }; finish: () => void };
function fakeDoc(anims: FakeAnim[]): Document {
  return {
    getAnimations: () => anims as unknown as Animation[],
    querySelectorAll: () => [] as unknown as NodeListOf<Element>,
    documentElement: { offsetHeight: 0 },
  } as unknown as Document;
}

describe("settleAnimationsForCapture", () => {
  it("finishes only finite iterations (an entry transition) and leaves infinite ones (a spinner) untouched", () => {
    const finished: string[] = [];
    const mk = (id: string, iterations: number): FakeAnim => ({
      id,
      effect: { getComputedTiming: () => ({ iterations }) },
      finish: () => finished.push(id),
    });
    settleAnimationsForCapture(fakeDoc([mk("fade-in", 1), mk("spinner", Infinity)]));
    expect(finished).toEqual(["fade-in"]);
  });

  it("settles the rest even when one animation's finish throws (already finished)", () => {
    const finished: string[] = [];
    const bad: FakeAnim = {
      id: "bad",
      effect: { getComputedTiming: () => ({ iterations: 1 }) },
      finish: () => {
        throw new Error("InvalidStateError");
      },
    };
    const good: FakeAnim = {
      id: "good",
      effect: { getComputedTiming: () => ({ iterations: 1 }) },
      finish: () => finished.push("good"),
    };
    settleAnimationsForCapture(fakeDoc([bad, good]));
    expect(finished).toEqual(["good"]);
  });
});
