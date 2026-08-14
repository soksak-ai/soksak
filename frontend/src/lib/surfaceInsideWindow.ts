// Is a surface inside the window — geometry invariant for out-of-document surfaces.
//
// Incident 2026-08-09: content surfaces scattered outside the window and overlapped at the right of
// the screen. `ui.verify` answered `passed` at that moment — that check read the DOM only, and what
// left the window was not the DOM but the out-of-document surfaces. Geometry is judged by geometry.

export interface SurfaceFrameFact {
  label: string;
  hidden?: boolean;
  effectivelyHidden?: boolean;
  frame: { x: number; y: number; w: number; h: number };
}

export interface SurfaceOverflow {
  label: string;
  frame: { x: number; y: number; w: number; h: number };
  overflow: { left: number; top: number; right: number; bottom: number };
}

/** A one-pixel rounding is not an incident — the real incident showed as hundreds of px. */
const TOLERANCE_PX = 2;

/** Surfaces that are visible but outside the window — drawn where no person can see them. */
export function surfacesOutsideWindow(
  surfaces: readonly SurfaceFrameFact[],
  window: { w: number; h: number },
): SurfaceOverflow[] {
  // No judgement without the window size — at 0 every surface reads as outside.
  if (!(window.w > 0) || !(window.h > 0)) return [];
  const out: SurfaceOverflow[] = [];
  for (const surface of surfaces) {
    if (surface.hidden === true || surface.effectivelyHidden === true) continue;
    const { x, y, w, h } = surface.frame;
    const overflow = {
      left: Math.max(0, Math.round(-x)),
      top: Math.max(0, Math.round(-y)),
      right: Math.max(0, Math.round(x + w - window.w)),
      bottom: Math.max(0, Math.round(y + h - window.h)),
    };
    const worst = Math.max(overflow.left, overflow.top, overflow.right, overflow.bottom);
    if (worst > TOLERANCE_PX) out.push({ label: surface.label, frame: surface.frame, overflow });
  }
  return out;
}

/**
 * Surfaces visible on the native layer that the **app has no record of**.
 *
 * The app's ghost check scans its own ledger, so a surface already dropped from the ledger but
 * still present natively is never caught — measured 2026-08-09: a tab was closed, that surface
 * stayed visible, and `ghosts` was an empty list. That surface costs a check on every switch and
 * covers the screen with no record of it anywhere.
 */
export function unknownSurfaces(
  surfaces: readonly SurfaceFrameFact[],
  /** Knowledge comes from several sources — anything that returns a verdict for one label works. */
  known: { has(label: string): boolean },
): string[] {
  return surfaces
    .filter((row) => row.hidden !== true && row.effectivelyHidden !== true)
    .map((row) => row.label)
    .filter((label) => !known.has(label));
}
