import { useSyncExternalStore } from "react";
import { onParkedPictureChange, parkedPicture } from "../lib/parkedPicture";

// The picture a parked surface left, drawn where the surface was.
//
// A native surface is composited above the document, so nothing drawn in the document goes over it.
// The only way to show a card or a travelling rail over a page is to take the page off the screen,
// and a pane that goes blank is what a person reads as a view that failed — reported in those words
// on 2026-08-17, twice: a modal that blanked the browser, and a rail that passed under it.
//
// So the pane keeps showing the page's last frame while the surface is away. It is a picture, and
// what it does states that: it does not scroll, it takes no click, and it is one instant old. It is
// removed the moment the surface is back.
export function ParkedPicture({ viewId, dim }: { viewId: string; dim: number }) {
  const url = useSyncExternalStore(
    onParkedPictureChange,
    () => parkedPicture(viewId),
    () => null,
  );
  if (!url) return null;
  // The live pane reads the surface at its declared alpha over the dimmed document — a native
  // surface is composited above the focus lighting veil, which never reached it. The picture stands
  // in the document, so it reproduces that composite here: a veil at the same amount beneath it and
  // the image at the surface's alpha above. The lighting plane exempts a cell that draws this, so
  // the amount is applied once. Drawn under the plane's veil at full alpha instead, an unfocused
  // pane read 127 on white where the live one read 191 (measured 2026-09-04).
  return (
    <>
      {dim > 0 && (
        <div
          className="parked-picture-veil"
          data-node={`layout/parked-picture-veil/${viewId}`}
          aria-hidden="true"
          style={{ opacity: dim }}
        />
      )}
      <img
        className="parked-picture"
        data-node={`layout/parked-picture/${viewId}`}
        src={url}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{ opacity: 1 - dim }}
      />
    </>
  );
}
