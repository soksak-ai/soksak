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
const revision = moduleState("lib/parkedPicture#revision", () => ({ value: 0 }));
const failures = moduleState("lib/parkedPicture#failures", () => new Map<string, { label: string; reason: string }>());
// Who is waiting for a picture to be on screen. A surface is taken off only after that: hidden the
// moment the store holds the picture, one frame passes with the surface gone and nothing in its
// place — measured 2026-09-04, a pane read 127 on white for one frame between 191 and 191.
const showing = moduleState("lib/parkedPicture#showing", () => new Map<string, Array<() => void>>());
// Views whose picture the document has already drawn. The report and the wait are two async paths
// and either can be first; without this the wait that arrives second never ends and the surface
// stays up.
const shown = moduleState("lib/parkedPicture#shown", () => new Set<string>());

const announce = (): void => {
  revision.value += 1;
  for (const listener of listeners) listener();
};

/** Stable snapshot for one GroupArea subscription to the picture inventory. */
export function parkedPictureVersion(): number {
  return revision.value;
}

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

/** Failed capture attempts remain readable until that view captures successfully. */
export function parkedPictureFailures(): Array<{ view: string; label: string; reason: string }> {
  return [...failures.entries()]
    .map(([view, failure]) => ({ view, ...failure }))
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
export async function holdParkedPicture(viewId: string, label: string): Promise<boolean> {
  if (!hasContentViewHost() || asking.has(viewId)) return false;
  if (pictures.get(viewId)?.label === label) return true;
  asking.add(viewId);
  try {
    const url = await timedAwait("picture", contentViewHost().picture(label));
    if (url) {
      pictures.set(viewId, { url, label });
      failures.delete(viewId);
      announce();
      return true;
    } else {
      failures.set(viewId, { label, reason: "surface returned no picture" });
      announce();
      return false;
    }
  } catch (cause) {
    failures.set(viewId, {
      label,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    announce();
    return false;
  } finally {
    asking.delete(viewId);
  }
}

/** Drops the picture held for a view — the surface is back and is the thing to look at. */
export function releaseParkedPicture(viewId: string): void {
  shown.delete(viewId);
  showing.delete(viewId);
  if (!pictures.delete(viewId)) return;
  announce();
}

/** Removes all parking state when a view closes permanently. */
export function dropParkedPicture(viewId: string): void {
  const changed = pictures.delete(viewId) || failures.delete(viewId);
  asking.delete(viewId);
  shown.delete(viewId);
  showing.delete(viewId);
  if (changed) announce();
}

/** Test seam: places a picture without asking a surface for one. */
export function __setParkedPictureForTest(viewId: string, url: string): void {
  pictures.set(viewId, { url, label: `${viewId}#test` });
  announce();
}

/** Test seam: drops every held picture and every recorded failure. */
export function __resetParkedPicturesForTest(): void {
  pictures.clear();
  failures.clear();
  asking.clear();
  showing.clear();
  shown.clear();
  announce();
}

/** The document has drawn the picture held for this view. */
export function markParkedPictureShown(viewId: string): void {
  if (shown.has(viewId)) return;
  shown.add(viewId);
  // The declaration reads this: the surface stays applied until the picture is on screen.
  announce();
  const waiting = showing.get(viewId);
  if (!waiting) return;
  showing.delete(viewId);
  for (const wake of waiting) wake();
}

/** Resolves when the document has drawn the picture held for this view. */
export function whenParkedPictureShown(viewId: string): Promise<void> {
  if (shown.has(viewId)) return Promise.resolve();
  return new Promise((resolve) => {
    const waiting = showing.get(viewId);
    if (waiting) waiting.push(resolve);
    else showing.set(viewId, [resolve]);
  });
}

/** Whether the document has drawn the picture held for this view. */
export function parkedPictureShown(viewId: string): boolean {
  return shown.has(viewId);
}
