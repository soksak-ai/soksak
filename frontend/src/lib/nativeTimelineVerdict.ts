export interface TimelineRect { x: number; y: number; w: number; h: number }

export interface TimelineDomFrame {
  atUnixMs: number;
  drawn: boolean;
  surfaces: Array<{ id: string; visible: boolean; dom: TimelineRect }>;
}

export interface TimelineNativeSample {
  appliedAtUnixMs: number;
  surfaces: Array<{
    id: string;
    appliedVisible: boolean;
    /** Native host rectangle presented in the window. */
    applied: TimelineRect;
    /** Provider viewport rectangle when it is distinct and observable. */
    settled?: TimelineRect;
  }>;
}

export interface NativeTimelineVerdict {
  comparedFrames: number;
  unmatchedFrames: number;
  wrongFrames: number;
  worstOff: number;
  worstAppliedOff: number;
  worstSettledOff: number;
  longestWrongMs: number;
  maxAppliedAgeMs: number;
  nativeSamples: number;
}

const rectOff = (a: TimelineRect, b: TimelineRect): number => Math.max(
  Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h),
);

/**
 * Joins each displayed DOM frame to the newest native application that had actually completed by
 * that instant. A bridge response timestamp is deliberately not an input: it reports when the
 * answer returned, not when the native view moved.
 */
export function nativeTimelineVerdict(
  frames: TimelineDomFrame[],
  native: TimelineNativeSample[],
  tolerance = 0,
): NativeTimelineVerdict {
  const ordered = [...native].sort((a, b) => a.appliedAtUnixMs - b.appliedAtUnixMs);
  let nativeIndex = -1;
  let comparedFrames = 0;
  let unmatchedFrames = 0;
  let wrongFrames = 0;
  let worstOff = 0;
  let worstAppliedOff = 0;
  let worstSettledOff = 0;
  let maxAppliedAgeMs = 0;
  let wrongStartedAt: number | null = null;
  let lastWrongAt = 0;
  let longestWrongMs = 0;

  for (const frame of frames) {
    if (!frame.drawn) continue;
    while (nativeIndex + 1 < ordered.length
        && ordered[nativeIndex + 1].appliedAtUnixMs <= frame.atUnixMs) nativeIndex += 1;
    const sample = ordered[nativeIndex];
    if (!sample) {
      unmatchedFrames += 1;
      continue;
    }
    const applied = new Map(sample.surfaces.map((surface) => [surface.id, surface]));
    let frameCompared = false;
    let frameOff = 0;
    for (const surface of frame.surfaces) {
      if (!surface.visible) continue;
      const nativeSurface = applied.get(surface.id);
      if (!nativeSurface?.appliedVisible) continue;
      frameCompared = true;
      const appliedOff = rectOff(surface.dom, nativeSurface.applied);
      // A correctly moved clipping host is not sufficient: the provider viewport is what renders
      // the content. When a backend exposes it, both rectangles must match this frame's DOM box.
      const settledOff = nativeSurface.settled
        ? rectOff(surface.dom, nativeSurface.settled)
        : appliedOff;
      worstAppliedOff = Math.max(worstAppliedOff, appliedOff);
      worstSettledOff = Math.max(worstSettledOff, settledOff);
      frameOff = Math.max(frameOff, appliedOff, settledOff);
    }
    if (!frameCompared) {
      unmatchedFrames += 1;
      continue;
    }
    comparedFrames += 1;
    maxAppliedAgeMs = Math.max(maxAppliedAgeMs, frame.atUnixMs - sample.appliedAtUnixMs);
    worstOff = Math.max(worstOff, frameOff);
    if (frameOff > tolerance) {
      wrongFrames += 1;
      wrongStartedAt ??= frame.atUnixMs;
      lastWrongAt = frame.atUnixMs;
      longestWrongMs = Math.max(longestWrongMs, lastWrongAt - wrongStartedAt);
    } else {
      wrongStartedAt = null;
    }
  }
  return {
    comparedFrames, unmatchedFrames, wrongFrames, worstOff, longestWrongMs,
    worstAppliedOff, worstSettledOff, maxAppliedAgeMs, nativeSamples: ordered.length,
  };
}
