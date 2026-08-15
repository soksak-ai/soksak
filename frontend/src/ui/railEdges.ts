import type { RailLook } from "../state/settings";

type PaneStyle = "flat" | "card" | "floating";

// Ownership of the rail's vertical edge lines — composed from railLook and the theme paneStyle.
// ground draws no line of its own by default: the neighbour (pane card outline, divider) draws
// the border, so a rail line on top of it makes a double line. flat is the exception — the
// neighbour draws no outline there, so that delegation does not hold (measured: on Bare light the
// sidebar-feature border vanished) — under flat the ground rail draws its own seam.
//
// **The outer edge is different.** The delegation argument holds only for a seam between two
// surfaces. At the window's outer edge there is no second surface, and the OS window frame already
// draws the border at that position (§B2a). So an edge station omits its outer side regardless of
// look.
//
// Measured 2026-08-15 (flat, window width 1000): the rail's left x=0 was drawn and the pane's
// right x=1000 was not. Same kind of side, handled differently by the two surfaces, and the
// verifier passed both because the contract was written that way.
export function railEdgeWidths(
  look: RailLook,
  open: boolean,
  station: number,
  paneStyle: PaneStyle,
): { left: number; right: number } {
  if (!open) return { left: 0, right: 0 };
  // An edge station omits its outer side — §B2a, independent of look.
  const inner = { left: station > 0 ? 1 : 0, right: station < 100 ? 1 : 0 };
  if (look === "ground") {
    return paneStyle === "flat" ? inner : { left: 0, right: 0 };
  }
  return inner;
}
