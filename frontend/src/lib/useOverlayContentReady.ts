// When a modal's content may be shown without revealing itself in pieces.
//
// A modal is a document overlay, and a native surface is composited above the document — so where a
// modal's card is over a terminal, the card is under the live surface until that surface parks, and
// where it is over the chrome it shows at once. Shown as it renders, the card appears in pieces: the
// chrome part first, the terminal parts as each parks (measured 2026-09-05, the settings card
// appeared right-to-left). So the card waits: it is held until GroupArea reports every covered
// surface parked and its picture on screen, then it appears whole in one frame. During the wait the
// screen is unchanged — a parked surface's picture stands in for it, pixel for pixel.
import { useLayoutEffect, useState } from "react";
import { useOverlayCoverReady } from "../state/overlayCoverReady";

/**
 * Whether an open modal's card may be shown yet.
 *
 * False until GroupArea reports the surfaces the modal covers have parked, so the card appears in one
 * frame rather than piece by piece. A modal that covers no surface is reported ready at once. Ready
 * latches: once shown, the card stays shown for the life of the modal.
 */
export function useOverlayContentReady(active: boolean): boolean {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (!active) {
      setReady(false);
      return;
    }
    // Held not-ready first, before GroupArea's next commit: without this the store's standing "nothing
    // covered" state would show the card for a frame before the park it is about to trigger begins.
    useOverlayCoverReady.getState().set(true, false);
    const check = () => {
      if (useOverlayCoverReady.getState().allShown) setReady(true);
    };
    const unsub = useOverlayCoverReady.subscribe(check);
    check();
    // A capture that never finishes must not hold the card forever.
    const timer = window.setTimeout(() => setReady(true), 500);
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, [active]);
  return active && ready;
}
