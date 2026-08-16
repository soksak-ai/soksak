import { nativeSurfaceDOMRuntime, startNativeSurfaceObserver } from "@soksak/wails-service-native-compositor";
import type { NativeSurfaceCommit, NativeSurfaceObserverController } from "@soksak/wails-service-native-compositor";

import * as CompositorService from "../../../bindings/github.com/soksak/wails-service-native-compositor/service";
import { Snapshot } from "../../../bindings/github.com/soksak/wails-service-native-compositor/models";
import { currentWindowLabel } from "../../lib/webviewLabels";

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

/**
 * The window this document is.
 *
 * Every surface declared here is attached to this window's content view. The commit states the
 * name and the host resolves that window's handle. Measured 2026-08-16, with no name in the
 * snapshot: the host held a single handle, a workspace window's browser was created inside the
 * orchestrator — 1128×718 inside a 999×617 window — and the pane a person was looking at stayed
 * empty while every reading reported the surface applied with zero drift.
 */
function declaringWindow(): string {
  const label = currentWindowLabel();
  if (!label) {
    // Refused here rather than at the commit. Boot resolves the name before it installs this
    // adapter (main.tsx awaits resolveWindowLabel first), so an empty one is a broken boot order,
    // and the commit would fail inside a microtask where the only witness is
    // `controller.status().error` — an unhandled rejection and a screen with no surfaces on it.
    throw new Error("native surfaces: this window has no name yet; the commit would name no window");
  }
  return label;
}

export function startNativeSurfaces(root: Document = document): void {
  controller?.stop();
  watching = root;
  controller = startNativeSurfaceObserver(nativeSurfaceDOMRuntime(root), commit, declaringWindow(), sequenceFloor);
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
  await commit({ window: declaringWindow(), sequence: sequenceFloor, surfaces: [] });
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

/** How long a wait for a frame may go on before it states what did not arrive. */
const SETTLE_LIMIT_MS = 5_000;

/** Status the wait reads. Replaced only by a test — the observer is the writer in a running build. */
let statusOverride: (() => ReturnType<NativeSurfaceObserverController["status"]>) | null = null;

export function __setNativeSurfaceStatusForTest(
  read: (() => ReturnType<NativeSurfaceObserverController["status"]>) | null,
): void {
  statusOverride = read;
}

/**
 * Waits until the declared surfaces are reflected in an actual frame.
 *
 * The observer has one writer, and events that arrive during a commit collect into the next full snapshot.
 * So settled means "the applied sequence has caught up with the declared sequence and nothing is pending" —
 * the sequence is the test, not elapsed time.
 *
 * A commit that never catches up used to spin here without end, and the command awaiting it never
 * answered: `workspace.rightbar.toggle` closed the sidebar on screen and replied nothing, twice, in
 * 20 seconds (measured 2026-08-16). A command that does its work and never replies is dead from
 * outside. The wait still ends on the sequence; what is added is that a wait which cannot end names
 * the two numbers instead of never returning.
 */
export async function nativeSurfacesSettled(limitMs: number = SETTLE_LIMIT_MS): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const status = statusOverride ? statusOverride() : controller?.status();
    if (!status) return; // No observer means no surfaces.
    if (!status.dirty && status.committedSequence >= status.sequence) return;
    if (Date.now() - startedAt >= limitMs) {
      throw new Error(
        `native surfaces did not reach a frame in ${limitMs}ms: declared ${status.sequence}, ` +
          `committed ${status.committedSequence}` +
          (status.dirty ? ", still dirty" : "") +
          (status.running ? "" : ", observer not running") +
          (status.error ? `, last error: ${String(status.error)}` : ""),
      );
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
