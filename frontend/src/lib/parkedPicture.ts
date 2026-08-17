// What a parked surface leaves behind.
//
// A native surface is composited above the document, so nothing drawn in the document goes over it:
// a modal opens and the page covers the card, a rail travels across a pane and the page covers the
// rail. The only way to put something over a surface is to take it off the screen, and a pane that
// goes blank is what a person reads as a view that failed — which is exactly what was reported, in
// those words, on 2026-08-17.
//
// So the surface leaves its picture. The document draws it where the surface was, at the same box,
// and the screen keeps showing the page while the card or the rail is drawn over it. When the
// surface comes back the picture goes.
//
// It is a picture and not the page: it does not scroll, it does not answer a click, and it is one
// instant old. That is the whole of what it claims to be, and it is why the surface is put back the
// moment it can be.
import { contentViewHost, hasContentViewHost } from "./contentViews";
import { timedAwait } from "./mainThreadCost";
import { moduleState } from "./moduleState";

interface Held {
  /** The picture, as a data URL the document can draw. */
  url: string;
  /** The label it was taken from, so a second park of the same view does not ask twice. */
  label: string;
}

const pictures = moduleState("lib/parkedPicture#held", () => new Map<string, Held>());
const listeners = moduleState("lib/parkedPicture#listeners", () => new Set<() => void>());
const asking = moduleState("lib/parkedPicture#asking", () => new Set<string>());

const announce = (): void => {
  for (const listener of listeners) listener();
};

/** Subscribe to what is held. */
export function onParkedPictureChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The picture held for a view, if one is. */
export function parkedPicture(viewId: string): string | null {
  return pictures.get(viewId)?.url ?? null;
}

/** Every view holding a picture — what a reading of the window is judged by. */
export function parkedPictures(): Array<{ view: string; label: string; bytes: number }> {
  return [...pictures.entries()]
    .map(([view, held]) => ({ view, label: held.label, bytes: held.url.length }))
    .sort((a, b) => a.view.localeCompare(b.view));
}

/**
 * Takes the picture a view's surface is showing and holds it for that view.
 *
 * One request at a time per view: a park that asked again while the first answer was still coming
 * would put two captures on the thread that is drawing the thing being captured. A view whose
 * surface cannot answer keeps no picture, and the pane is then as blank as it was before — no worse,
 * and the reason is the surface's.
 */
export async function holdParkedPicture(viewId: string, label: string): Promise<void> {
  if (!hasContentViewHost() || asking.has(viewId)) return;
  if (pictures.get(viewId)?.label === label) return;
  asking.add(viewId);
  try {
    const url = await timedAwait("picture", contentViewHost().picture(label));
    if (url) {
      pictures.set(viewId, { url, label });
      announce();
    }
  } catch {
    // A surface that cannot be pictured leaves none. The pane shows what it showed before.
  } finally {
    asking.delete(viewId);
  }
}

/** Drops the picture held for a view — the surface is back and is the thing to look at. */
export function releaseParkedPicture(viewId: string): void {
  if (!pictures.delete(viewId)) return;
  announce();
}
