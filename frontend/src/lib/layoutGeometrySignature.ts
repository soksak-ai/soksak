// Everything a laid-out rectangle depends on, as one string.
//
// The rect tracker's contract is one flush per layout commit — its own words: "Once right after
// commit (useLayoutEffect) — compares against the previous rect and interpolates the delta." A
// flush cancels the running interpolation before measuring, which is right on its own terms: while
// one runs, `getBoundingClientRect` answers an interpolated value and the layout's present is only
// readable after the cancel.
//
// `GroupArea` ran it after every render instead, and after the cancel the element is already at its
// destination, so the delta is zero and no new animation starts. Measured 2026-08-17: `ui.motion`
// held 64 journeys and every one ended `cancel` 10–13ms in, with nothing running. No layout
// animation in this build had ever played, and a re-render inside 10ms is certain for a component
// subscribed to that many stores.
//
// So the effect is given what a rect is made of. Anything absent here is a change that moves an
// element and skips its motion, so the list is the whole of it: which cells there are and where,
// the rail that shifts them, the inset the theme adds, whether the layout was replaced rather than
// moved, and which slots exist — a slot rendered for the first time needs the flush that takes its
// baseline.

/** One cell as the layout places it. */
export interface SignedCell {
  id: string;
  rect: { left: number; top: number; width: number; height: number };
}

export function layoutGeometrySignature(input: {
  traveling: boolean;
  railStation: number;
  railWidthPx: number;
  paneInset: number;
  replaceGeometry: boolean;
  cells: SignedCell[];
  /** Every slot rendered under those cells, in render order. */
  slotIds: string[];
}): string {
  return [
    input.traveling ? "traveling" : "settled",
    input.railStation,
    input.railWidthPx,
    input.paneInset,
    input.replaceGeometry ? "replace" : "animate",
    input.cells
      .map((c) => `${c.id}:${c.rect.left},${c.rect.top},${c.rect.width},${c.rect.height}`)
      .join("|"),
    input.slotIds.join("|"),
  ].join(" ");
}
