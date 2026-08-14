// The two clocks of phase duration follow one multiplier.
//
// RED evidence (design defect, 2026-07-26): the observation multiplier was applied only through the Web
// Animations playbackRate, so only the CSS transition slowed while the JS timer that closes the phase stayed
// at 340ms. At 20x the JS declares landing when the screen has progressed 5% — the intermediate state under
// observation disappears because of the observation tool. An instrument that changes what it measures is not
// observation.
//
// The single truth of duration is RAIL_TRAVEL_MS alone, so the multiplier is applied there too. As long as the
// CSS variable injection and the JS timer call the same function, the two cannot diverge.
import { beforeEach, describe, expect, it } from "vitest";
import {
  RAIL_TRAVEL_MS,
  railTravelDeclaredMs,
  railTravelMs,
  railTravelWallMs,
} from "./railMotion";
import { __resetMotionDebugForTest, setMotionDebug } from "./motionDebug";

describe("railTravelMs — the multiplier is applied to the single source of the duration", () => {
  beforeEach(() => __resetMotionDebugForTest());

  it("is the constant itself at the default — the production path is unchanged", () => {
    expect(railTravelMs()).toBe(RAIL_TRAVEL_MS);
  });

  it("stretches the duration by the multiplier", () => {
    setMotionDebug({ scale: 20 });
    expect(railTravelMs()).toBe(RAIL_TRAVEL_MS * 20);
  });

  it("returns to the constant when the multiplier is reset", () => {
    setMotionDebug({ scale: 50 });
    setMotionDebug({ scale: 1 });
    expect(railTravelMs()).toBe(RAIL_TRAVEL_MS);
  });
});

describe("the two clocks agree — screen time equals the time the phase closes at", () => {
  beforeEach(() => __resetMotionDebugForTest());

  // RED evidence (real incident, 2026-07-26): the multiplier was applied to the **declaration** of a transition
  // already stretched by playbackRate, so the screen lagged by the square of the multiplier while the phase timer
  // was multiplied once. At 20x the phase closed where the travel had progressed 5%, the layers split and it
  // jumped — user measurement: "it slows down, then stops and goes back".
  for (const scale of [1, 5, 20, 50]) {
    it(`screen time and the timer do not diverge at ${scale}x`, () => {
      setMotionDebug({ scale });
      expect(railTravelWallMs()).toBe(railTravelMs());
    });
  }

  it("the declaration sent to CSS is the bare length whatever the multiplier — playbackRate is the only stretching axis", () => {
    setMotionDebug({ scale: 20 });
    expect(railTravelDeclaredMs()).toBe(RAIL_TRAVEL_MS);
  });
});
