export type SwitchFrameVerdict = {
  switchFrame: number;
  switchFrames: number;
  flickerFrames: number;
  clean: boolean;
};

export function classifySwitchFrames(frameDiffs: readonly number[], noiseFloor: number): SwitchFrameVerdict {
  const peak = frameDiffs.reduce(
    (maximum, value) => Number.isFinite(value) ? Math.max(maximum, value) : maximum,
    0,
  );
  const threshold = Math.max(noiseFloor, peak * 0.4);
  const changed = frameDiffs
    .map((value, frame) => ({ value, frame }))
    .filter(({ value }) => Number.isFinite(value) && peak >= noiseFloor && value >= threshold);
  const switchFrames = changed.length;
  return {
    switchFrame: changed[0]?.frame ?? -1,
    switchFrames,
    flickerFrames: Math.max(0, switchFrames - 1),
    clean: switchFrames === 1,
  };
}

export type SwitchViewPresentation = {
  native: boolean;
  contentVisible: boolean;
  /** DOM decision for the live native surface. False for a DOM-only view. */
  surfaceVisible: boolean;
  /** Last compositor receipt for this view's native surface. */
  liveSurfaceVisible: boolean;
  parkedPictureVisible: boolean;
};

export type SwitchPresentationSample = {
  frame: number;
  from: SwitchViewPresentation | readonly SwitchViewPresentation[];
  to: SwitchViewPresentation | readonly SwitchViewPresentation[];
};

export type SwitchPresentationVerdict = {
  blankFrames: number[];
  overlapFrames: number[];
  nativeMismatchFrames: number[];
  clean: boolean;
};

function presented(view: SwitchViewPresentation): boolean {
  // A parked picture is drawn in the document even after its view's content decision turned false.
  // Ignoring it calls the exact frame where the departing page covers the arriving view clean.
  if (view.parkedPictureVisible || view.liveSurfaceVisible) return true;
  if (!view.contentVisible) return false;
  if (!view.native) return true;
  return false;
}

function nativeMismatch(view: SwitchViewPresentation): boolean {
  return view.native
    && view.contentVisible
    && view.surfaceVisible !== view.liveSurfaceVisible;
}

function sideViews(
  side: SwitchViewPresentation | readonly SwitchViewPresentation[],
): readonly SwitchViewPresentation[] {
  return Array.isArray(side) ? side : [side as SwitchViewPresentation];
}

export function classifySwitchPresentation(
  samples: readonly SwitchPresentationSample[],
): SwitchPresentationVerdict {
  const blankFrames: number[] = [];
  const overlapFrames: number[] = [];
  const nativeMismatchFrames: number[] = [];
  for (const sample of samples) {
    const fromViews = sideViews(sample.from);
    const toViews = sideViews(sample.to);
    const from = fromViews.some(presented);
    const to = toViews.some(presented);
    if (!from && !to) blankFrames.push(sample.frame);
    if (from && to) overlapFrames.push(sample.frame);
    if (fromViews.some(nativeMismatch) || toViews.some(nativeMismatch)) {
      nativeMismatchFrames.push(sample.frame);
    }
  }
  return {
    blankFrames,
    overlapFrames,
    nativeMismatchFrames,
    clean: blankFrames.length === 0
      && overlapFrames.length === 0
      && nativeMismatchFrames.length === 0,
  };
}
