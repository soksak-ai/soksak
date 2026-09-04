import { type CSSProperties, useSyncExternalStore } from "react";
import { markParkedPictureShown, onParkedPictureChange, parkedPicture } from "../lib/parkedPicture";

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
export function ParkedPicture(
  { viewId, style }: { viewId: string; style: CSSProperties },
) {
  const url = useSyncExternalStore(
    onParkedPictureChange,
    () => parkedPicture(viewId),
    () => null,
  );
  if (!url) return null;
  // The picture is what the surface painted, drawn on the layer the surface was on (App.css). The
  // surface paints its own dim (surface.dim), so the picture already holds it: an opacity here
  // would apply the amount a second time, and the pane darkened the moment it parked.
  return (
    <img
        className="parked-picture"
        data-node={`layout/parked-picture/${viewId}`}
        src={url}
        alt=""
        aria-hidden="true"
        draggable={false}
      style={style}
      // The surface is taken off after the picture is on screen. A load reports the bytes decoded, not
      // the document drawing them: the pane read 129.7 on white for three frames between 224.7
      // and 224.7, with the surface gone and the picture not yet drawn.
      //
      // The next frame is the report. It is an event, not a clock, and the picture is staged under
      // an opaque surface meanwhile, so nothing is on screen for it to cost. A window nothing
      // paints reports nothing and its surface stays up, which is what an unseen window needs.
      onLoad={() => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => markParkedPictureShown(viewId));
        });
      }}
    />
  );
}
