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
export function ParkedPicture({ viewId }: { viewId: string }) {
  const url = useSyncExternalStore(
    onParkedPictureChange,
    () => parkedPicture(viewId),
    () => null,
  );
  if (!url) return null;
  return (
    <img
      className="parked-picture"
      data-node={`layout/parked-picture/${viewId}`}
      src={url}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
