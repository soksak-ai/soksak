import type { RailLook } from "../state/settings";

type PaneStyle = "flat" | "card" | "floating";

// One rail perimeter contract: the rail card owns both vertical edges in every
// look, theme and station. The card is inset from its neighbour, so delegating
// an edge to the pane or to the OS creates a missing line at some station. The
// only station-dependent fact is position; ownership, width and token stay the
// same everywhere.
export function railEdgeWidths(
  look: RailLook,
  open: boolean,
  station: number,
  paneStyle: PaneStyle,
): { left: number; right: number } {
  if (!open) return { left: 0, right: 0 };
  void look;
  void station;
  void paneStyle;
  return { left: 1, right: 1 };
}
