import { nativeSurfaceDOMRuntime, startNativeSurfaceObserver } from "@min-median-max/wails-service-native-compositor";
import type {
  NativeSurfaceCommit,
  NativeSurfaceObserverController,
  NativeSurfacePresentation,
} from "@min-median-max/wails-service-native-compositor";

import * as CompositorService from "../../../bindings/github.com/min-median-max/wails-service-native-compositor/service";
import { Snapshot } from "../../../bindings/github.com/min-median-max/wails-service-native-compositor/models";
import { noteAppliedSurfaces } from "../../lib/contentViews";
import { presentationNowUnixMs } from "../../lib/presentationClock";
import { nextFrame } from "../../lib/nextFrame";
import { currentWindowLabel } from "../../lib/webviewLabels";
import { layoutMotionFacts, onLayoutMotion } from "../../lib/layoutMotion";
import { compositionOwnerViewId } from "../../lib/compositionParticipants";

/**
 * How long a commit may go unanswered before it fails by name.
 *
 * The observer runs one commit at a time — `running` is true for the whole round trip and every
 * change made meanwhile only marks the inventory dirty. With no bound, a backend that accepted a
 * delivery and never replied left `running` true for the rest of the session: nothing else could be
 * delivered and the status read `declared 22, committed 21, still dirty` with no error, forever.
 *
 * Measured 2026-08-19, three times in one suite. Shorter than the barrier that reads this status,
 * so the failure is stated in these words rather than the caller's.
 */
export const NATIVE_COMMIT_LIMIT_MS = 2_000;

/**
 * One delivery to the compositor, bounded.
 *
 * The bound cancels nothing — nothing here can reach into the backend. It names the failure and
 * releases the observer for the next delivery; a receipt that arrives late is refused by its
 * sequence, which the observer already does.
 */
type CompositorReceipt = Awaited<ReturnType<typeof CompositorService.Commit>>;
let lastNotedSequence = 0;
let interactiveDeliveryFailure: unknown = null;
let lastPresentationSignature: string | null = null;

function presentationSignature(snapshot: Parameters<NativeSurfaceCommit>[0]): string {
  return JSON.stringify(snapshot.surfaces.map((surface) => ({
    id: surface.id,
    generation: surface.generation,
    kind: surface.kind,
    visible: surface.visible,
    alpha: surface.alpha,
    layer: surface.layer,
    source: Object.fromEntries(Object.entries(surface.source).sort(([left], [right]) => (
      left.localeCompare(right)
    ))),
  })));
}

export function __resetNativeSurfaceCommitForTest(): void {
  lastNotedSequence = 0;
  interactiveDeliveryFailure = null;
  lastPresentationSignature = null;
}

function noteReceipt(snapshot: Parameters<NativeSurfaceCommit>[0], receipt: CompositorReceipt, askedAt: number): void {
  if (!receipt.accepted || receipt.sequence !== snapshot.sequence || receipt.sequence <= lastNotedSequence) return;
  lastNotedSequence = receipt.sequence;
  lastPresentationSignature = presentationSignature(snapshot);
  const answeredAt = presentationNowUnixMs();
  noteAppliedSurfaces(
    (receipt.surfaces ?? []).map((surface) => ({
      id: surface.id, x: surface.frame.x, y: surface.frame.y,
      w: surface.frame.width, h: surface.frame.height,
      ...(surface.settled ? { settled: { x: surface.settled.x, y: surface.settled.y, w: surface.settled.width, h: surface.settled.height } } : {}),
      visible: surface.visible,
    })),
    answeredAt, answeredAt - askedAt, receipt.appliedMs ?? -1, receipt.carriedMs ?? -1,
    snapshot.interactive,
  );
  document.documentElement.dataset.nativeSnapshotSequence = String(receipt.sequence);
  document.documentElement.dataset.nativeSnapshotAccepted = String(receipt.accepted);
  document.documentElement.dataset.nativeSnapshotCount = String(receipt.surfaces.length);
}

export const commitNativeSurfaces: NativeSurfaceCommit = async (snapshot) => {
  const askedAt = presentationNowUnixMs();
  const presentationChanged = presentationSignature(snapshot) !== lastPresentationSignature;
  if (snapshot.interactive && !presentationChanged) {
    void CompositorService.Commit(Snapshot.createFrom(snapshot))
      .then((receipt) => noteReceipt(snapshot, receipt, askedAt))
      .catch((error) => { interactiveDeliveryFailure = error; });
    return { sequence: snapshot.sequence, accepted: true, surfaces: [] };
  }
  if (interactiveDeliveryFailure) {
    const failure = interactiveDeliveryFailure;
    interactiveDeliveryFailure = null;
    throw new Error(`interactive native surface delivery failed before sequence ${snapshot.sequence}: ${String(failure)}`);
  }
  let expiry = 0;
  const receipt = await Promise.race([
    CompositorService.Commit(Snapshot.createFrom(snapshot)),
    new Promise<never>((_, reject) => {
      expiry = window.setTimeout(
        () =>
          reject(
            new Error(
              `the compositor did not answer the commit for sequence ${snapshot.sequence} ` +
                `within ${NATIVE_COMMIT_LIMIT_MS}ms`,
            ),
          ),
        NATIVE_COMMIT_LIMIT_MS,
      );
    }),
  ]).finally(() => clearTimeout(expiry));
  noteReceipt(snapshot, receipt, askedAt);
  return receipt;
};

const commit: NativeSurfaceCommit = commitNativeSurfaces;

let controller: NativeSurfaceObserverController | null = null;
let stopMotion: (() => void) | null = null;
let presentationVisibleFromDOM: NativeSurfacePresentation | null = null;
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
  stopMotion?.();
  controller?.stop();
  watching = root;
  const runtime = nativeSurfaceDOMRuntime(root);
  presentationVisibleFromDOM = runtime.presentationVisible;
  controller = startNativeSurfaceObserver(runtime, commit, declaringWindow(), sequenceFloor);
  controller.setInteractive(layoutMotionFacts().active);
  stopMotion = onLayoutMotion((active) => controller?.setInteractive(active));
}

/** Applies target view ownership before React publishes the matching tab visibility DOM. */
export async function stageNativeSurfacePresentation(
  visibleViewIds: ReadonlySet<string>,
): Promise<{ sequence: number; visibleViewIds: string[] }> {
  if (!controller) throw new Error("native surface observer is not installed");
  const receipt = await controller.stagePresentation((declaration) => {
    const owner = compositionOwnerViewId(declaration as HTMLElement);
    return owner !== null && visibleViewIds.has(owner);
  });
  return { sequence: receipt.sequence, visibleViewIds: [...visibleViewIds].sort() };
}

/** Re-applies the current DOM presentation after a staged transaction is cancelled. */
export async function restoreNativeSurfacePresentation(): Promise<void> {
  if (!controller || !presentationVisibleFromDOM) return;
  await controller.stagePresentation(presentationVisibleFromDOM);
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
  stopMotion?.();
  stopMotion = null;
  controller?.stop();
  controller = null;
  presentationVisibleFromDOM = null;
  sequenceFloor += 1;
  // Stamped like every other commit, so a receipt for this one splits the same way.
  await commit({
    window: declaringWindow(),
    sequence: sequenceFloor,
    interactive: false,
    surfaces: [],
    sentAtUnixMs: Date.now(),
  });
}

/**
 * Destroys the children this window holds and observes the document again.
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

/** How long the wait gives the frame clock before it looks at the time itself. */
const SETTLE_TICK_MS = 16;

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
export async function nativeSurfacesSettled(limitMs?: number): Promise<void> {
  const limit = limitMs !== undefined && limitMs > 0 ? limitMs : SETTLE_LIMIT_MS;
  const startedAt = Date.now();
  for (;;) {
    const status = statusOverride ? statusOverride() : controller?.status();
    if (!status) return; // No observer means no surfaces.
    if (!status.dirty && status.committedSequence >= status.sequence) return;
    if (Date.now() - startedAt >= limit) {
      throw new Error(
        `native surfaces did not reach a frame in ${limit}ms: declared ${status.sequence}, ` +
          `committed ${status.committedSequence}` +
          (status.dirty ? ", still dirty" : "") +
          (status.running ? "" : ", observer not running") +
          (status.error ? `, last error: ${String(status.error)}` : ""),
      );
    }
    // The frame is what a commit lands in; the timer is what makes this wait end at all. Both live
    // in `nextFrame` so every wait for a frame in this build has the same guarantee.
    await nextFrame(SETTLE_TICK_MS);
  }
}
