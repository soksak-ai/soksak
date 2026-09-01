import type { RailLook } from "../state/settings";

type PaneStyle = "flat" | "card" | "floating";

// One rail perimeter contract: the rail card owns all four edges in every
// look, theme and station. The card is inset from its neighbour, so delegating
// an edge to the pane or to the OS creates a missing line at some station. The
// only station-dependent fact is position; ownership, width and token stay the
// same everywhere.
export function railEdgeWidths(
  look: RailLook,
  open: boolean,
  station: number,
  paneStyle: PaneStyle,
): { top: number; right: number; bottom: number; left: number } {
  if (!open) return { top: 0, right: 0, bottom: 0, left: 0 };
  void look;
  void station;
  void paneStyle;
  return { top: 1, right: 1, bottom: 1, left: 1 };
}
