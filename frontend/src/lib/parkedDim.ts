// Which pane cells already carry a dim of their own.
//
// A parked surface leaves a picture, and that picture was captured from a surface that had applied
// the cell's `--dim` to its own alpha. The document then draws the picture where the surface was.
// The lighting plane dims the document once, so a veil over that picture dims it a second time —
// measured 2026-09-04: opening the program menu made every unfocused pane visibly darker.
//
// Only the tab the cell is showing counts. A picture held for another tab of the same cell is
// no reading of what is on screen, and treating it as one left the pane with no veil and no
// picture, with its content gone.

/** Whether the cell showing `shownTabId` is already dimmed by a picture it is drawing. */
export function cellCarriesOwnDim(
  shownTabId: string | null,
  heldPictures: ReadonlySet<string>,
): boolean {
  return shownTabId !== null && heldPictures.has(shownTabId);
}
