// What an open overlay covers.
//
// A native surface is composited above the document, so an overlay drawn over one is drawn under it
// until that surface steps aside and its picture stands in. That swap crosses two compositing
// layers and cannot land in one frame: measured 2026-09-04, a pane read one frame brighter with
// both on screen and three frames darker with neither.
//
// So only the surfaces an overlay actually covers step aside. A dropdown over 31px of one pane left
// every pane in the window swapping for it.

import type { OverlayArea } from "../state/ui";

/** Whether any open overlay covers this box. An overlay that names no area covers the window. */
export function coversBox(
  overlays: readonly (OverlayArea | null)[],
  box: OverlayArea,
): boolean {
  return overlays.some((area) =>
    area === null
    || (area.left < box.right && box.left < area.right
      && area.top < box.bottom && box.top < area.bottom),
  );
}
