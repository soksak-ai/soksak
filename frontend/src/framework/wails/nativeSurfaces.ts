import { nativeSurfaceDOMRuntime, startNativeSurfaceObserver } from "@soksak/wails-service-native-compositor";
import type { NativeSurfaceCommit, NativeSurfaceObserverController } from "@soksak/wails-service-native-compositor";

import * as CompositorService from "../../../bindings/github.com/soksak/wails-service-native-compositor/service";
import { Snapshot } from "../../../bindings/github.com/soksak/wails-service-native-compositor/models";

const commit: NativeSurfaceCommit = async (snapshot) => {
  const receipt = await CompositorService.Commit(Snapshot.createFrom(snapshot));
  // Publish the applied inventory on the document, so the composition check reads this one receipt instead
  // of recomputing the geometry from a second source.
  document.documentElement.dataset.nativeSnapshotSequence = String(receipt.sequence);
  document.documentElement.dataset.nativeSnapshotAccepted = String(receipt.accepted);
  document.documentElement.dataset.nativeSnapshotCount = String(receipt.surfaces.length);
  return receipt;
};

let controller: NativeSurfaceObserverController | null = null;
// The compositor refuses a sequence it has already passed, so the counter has to survive a restart.
// A fresh observer starts its own at 1, and every commit after a restart would be rejected as stale:
// the screen would hold the last accepted inventory and nothing after it.
let sequenceFloor = 0;
let watching: Document | null = null;

export function startNativeSurfaces(root: Document = document): void {
  controller?.stop();
  watching = root;
  controller = startNativeSurfaceObserver(nativeSurfaceDOMRuntime(root), commit, sequenceFloor);
}

/**
 * Stops watching and destroys every native child this window holds.
 *
 * Used where the window itself is about to go: a renderer reload leaves a ~150ms gap in which the
 * backend still owns the previous surfaces, and a ghost browser is visible over nothing. Watching
 * has to stop with it — a live observer re-commits the declarations that are still in the document
 * and puts the children straight back.
 */
export async function clearNativeSurfaces(): Promise<void> {
  if (controller) sequenceFloor = controller.status().sequence;
  controller?.stop();
  controller = null;
  sequenceFloor += 1;
  await commit({ sequence: sequenceFloor, surfaces: [] });
}

/**
 * Destroys the children this window holds and watches the document again.
 *
 * Boot calls this before the restore render: the previous session's surfaces are backend-owned and
 * survive a renderer reload, so without it the old browser stays over an empty pre-restore screen
 * (measured 2026-07-27, Example Domain over an empty window).
 *
 * Clearing without watching again keeps only half the promise, and the other half is the whole
 * session: measured 2026-08-16, boot stopped the observer and nothing started it, so a browser pane
 * declared its surface, all seven attributes were on the element, and the compositor stayed at
 * sequence 1 with count 0 for as long as the window was open.
 */
export async function resetNativeSurfaces(): Promise<void> {
  const root = watching ?? document;
  await clearNativeSurfaces();
  startNativeSurfaces(root);
}

/**
 * Waits until the declared surfaces are reflected in an actual frame.
 *
 * The observer has one writer, and events that arrive during a commit collect into the next full snapshot.
 * So settled means "the applied sequence has caught up with the declared sequence and nothing is pending" —
 * the sequence is the test, not elapsed time.
 */
export async function nativeSurfacesSettled(): Promise<void> {
  for (;;) {
    const status = controller?.status();
    if (!status) return; // No observer means no surfaces.
    if (!status.dirty && status.committedSequence >= status.sequence) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
