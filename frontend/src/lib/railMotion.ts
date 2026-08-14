import { motionPlaybackRate, motionScale } from "./motionDebug";

/** Time the rail corridor takes to contract or expand from the source layout to the target layout.
 *  One constant, the same one the DOM curve uses.
 *
 *  It was 340ms. A user pressed a tab, saw the sidebar change, and called it too slow; this interval
 *  is that change — layout was already done at 9ms (measured 2026-08-09), so the time left on screen
 *  is this curve. 180ms shows the transition without reading as a wait. */
export const RAIL_TRAVEL_MS = 180;

/**
 * Wall time this phase actually takes on screen — an expected value. Never put it into a schedule.
 *
 * There is one clock: the document timeline. Both the CSS animation and the phase-landing schedule
 * (scheduleMotion) ride on it, so rate multipliers and pauses apply to both without exception. A
 * caller that multiplies the rate again here doubles it — the screen lags by the square while the
 * landing arrives first and closes the phase mid-travel (a real incident).
 * This function is the expected wall clock read by the side that checks that pairing (tests, diagnostics).
 */
export function railTravelMs(): number {
  return RAIL_TRAVEL_MS * motionScale();
}

/**
 * The duration that goes out as a CSS declaration — always the bare constant.
 *
 * playbackRate is the only axis that opens the observation multiplier, and it already stretches this
 * declaration. If the injection site multiplies again here, the screen lags by the square while the
 * phase timer is multiplied once and the pairing breaks. So the injection site uses this function
 * instead of the constant — the pairing check (railTravelWallMs) reads this axis.
 */
export function railTravelDeclaredMs(): number {
  return RAIL_TRAVEL_MS;
}

/** Time the screen actually spends once playback rate is applied to the declared duration. Must equal the phase timer. */
export function railTravelWallMs(): number {
  return railTravelDeclaredMs() / motionPlaybackRate();
}

export type RailPresentation = {
  key: "persistent-rail";
  station: number;
  fromStation: number;
  moving: boolean;
  visible: boolean;
};

/**
 * The rail is one persistent DOM node that preserves lifetime, but it is not a moving object.
 * During the phase its surface is removed, and after settling it is visible again at the target
 * station. No source/target duplicate is created — a duplicate splits plugin lifetime.
 */
export function railPresentation(
  fromStation: number,
  targetStation: number,
  traveling: boolean,
): RailPresentation {
  return {
    key: "persistent-rail",
    station: targetStation,
    fromStation: traveling ? fromStation : targetStation,
    moving: traveling && fromStation !== targetStation,
    // During FLOW travel a pane surface can pass behind the rail even when the rail station itself is
    // unchanged. So visibility is owned by the structural transition phase, not by the station delta.
    // Keep the persistent host's lifetime, remove every visual surface, border, and input area, and
    // open them again at the target station after landing.
    visible: !traveling,
  };
}

/** The one FLIP offset that reproduces the source rail position inside the target layout. */
export function railFlipOffsetPx(
  fromStation: number,
  targetStation: number,
  planeWidthPx: number,
  railWidthPx: number,
): number {
  const available = Math.max(0, planeWidthPx - railWidthPx);
  return ((fromStation - targetStation) / 100) * available;
}

/** Identity of a panel plane that can share rail travel. A split/merge that changes the line set makes a new plane. */
export function railGeometryScopeId(
  spaceId: string | undefined,
  cleanLines: readonly number[],
): string {
  return `${spaceId ?? ""}:${cleanLines.join(",")}`;
}
