import {
  LAYOUT_SETTLEMENT_ANIMATION_ID,
  layoutMotionFacts,
  onLayoutMotion,
} from "../lib/layoutMotion";
import {
  layoutSettlementFacts,
  layoutSettlementEvents,
  onLayoutSettlement,
} from "../lib/layoutSettlement";
import {
  CONTENT_VIEW_BODY,
  contentViewHost,
  contentViewSlotVisible,
  hasContentViewHost,
} from "../lib/contentViews";
import { pluginViewPresentationHost } from "../plugins/viewPresentationHost";
import { PRESENTATION_CLOCK, presentationNowUnixMs } from "../lib/presentationClock";
import { layoutArrangementPhaseFacts } from "../lib/layoutArrangementPhase";
import { layoutTransitionIntentFacts } from "../lib/layoutTransitionIntent";
import { moduleState } from "../lib/moduleState";
import {
  LayoutSettlementFailure,
  LayoutSettlementTimeout,
  serializePresentationProviderError,
  type PresentationBarrierSuccess,
} from "../lib/presentationSettlement";

type NamedAnimation = Animation & { animationName?: string };

/** How long before this wait's own deadline the barrier gives up, so its reason travels back before
 *  the timer here fires. One round trip through the compositor and the socket is what it leaves. */
const PRESENTATION_BARRIER_MARGIN_MS = 250;

const presentationPendingState = moduleState("commands/waitLayoutSettled#presentationPending", () => ({
  sequence: 0,
  content: new Map<number, {
    owner: "content";
    labels: string[];
    startedAtUnixMs: number;
    startedAtPerformanceMs: number;
  }>(),
}));

function liveLayoutAnimations(): NamedAnimation[] {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") return [];
  return document.getAnimations().filter((animation) => {
    const named = animation as NamedAnimation;
    return (
      (animation.playState === "running" || animation.pending) &&
      (named.animationName === "rail-flip-x" || animation.id === LAYOUT_SETTLEMENT_ANIMATION_ID)
    );
  }) as NamedAnimation[];
}

function visibleContentViewLabels(): string[] {
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll<HTMLElement>(`[${CONTENT_VIEW_BODY}]`)]
    .filter(contentViewSlotVisible)
    .map((slot) => slot.getAttribute(CONTENT_VIEW_BODY) ?? "")
    .filter(Boolean);
}

/** Public diagnostic surface of this window's layout barrier. TIMEOUT and manual diagnosis read the
 *  same facts. */
export function layoutSettlementStatus(settlementKey?: string) {
  const animations = liveLayoutAnimations();
  const nowPerformance = performance.now();
  const pluginPresentation = pluginViewPresentationHost();
  const presentationPending = [
    ...[...presentationPendingState.content.values()].map((entry) => ({
      owner: entry.owner,
      labels: [...entry.labels],
      startedAtUnixMs: entry.startedAtUnixMs,
      elapsedMs: Math.max(0, nowPerformance - entry.startedAtPerformanceMs),
    })),
    ...(pluginPresentation?.presentationPending?.() ?? []),
  ];
  return {
    settled: !layoutMotionFacts().active
      && !layoutSettlementFacts(settlementKey).active
      && animations.length === 0,
    motion: layoutMotionFacts(),
    settlement: layoutSettlementFacts(settlementKey),
    settlementEvents: layoutSettlementEvents(settlementKey),
    arrangementPhases: layoutArrangementPhaseFacts(),
    transitionIntents: layoutTransitionIntentFacts(),
    animations: animations.map((animation) => ({
      id: animation.id,
      name: animation.animationName ?? "",
      playState: animation.playState,
      pending: Boolean(animation.pending),
    })),
    contentViewLabels: visibleContentViewLabels(),
    presentationPending,
  };
}

/**
 * Waits for the edge where a layout transaction closes. No polling, no interval. Consumes only
 * layout state edges and Web Animations finished promises; the timeout is the upper bound that
 * keeps a defect from holding the command forever.
 *
 * The receipt reports both the settlement epoch (presentation clock — the same axis as the layout
 * journal and the native display ledger) and whether the surface owner confirmed. A caller that
 * stamps the settlement time from its own clock produces a different fact, one that includes the
 * RPC round trip.
 */
export function waitLayoutSettled(timeoutMs = 4_000, settlementKey?: string): Promise<{
  /** A successful barrier is stated explicitly, so the caller does not infer it from other fields. */
  settled: true;
  waitedMs: number;
  animations: number;
  settledAtUnixMs: number;
  /** Name of the clock that produced this receipt's `...UnixMs` timestamps. */
  clock: string;
  syncPending: boolean;
  /**
   * Breakdown of the confirmation interval — time spent asking whether the surface reached screen.
   *
   * When settlement still waits after DOM and motion finish, all of that time is here (measured
   * 2026-08-09: DOM finished at 9ms, settlement at 100ms). Several calls sit inside it, so with no
   * way to ask which one, whoever fixes it guesses the culprit — two such guesses produced code
   * 2x and 4x slower.
   */
  presentation: {
    content: PresentationBarrierSuccess | null;
    view: PresentationBarrierSuccess | null;
  };
}> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let closed = false;
    let generation = 0;
    let timer = 0;
    let quietFrame: number | null = null;
    let unsubscribe = () => {};
    let unsubscribeSettlement = () => {};
    let presentationPending: Promise<void> | null = null;
    let presentationAbort: AbortController | null = null;
    const ownedContentPendingIds = new Set<number>();
    let presentationSettled = false;
    // A new motion/revision edge after a settlement confirmation started makes that confirmation a
    // fact of the old generation. Rather than force-cancel a native promise that cannot be
    // cancelled, only the generation advances, so neither a late success nor a late failure is
    // adopted as this transaction's verdict. The same public barrier is called again at the next
    // quiet edge.
    let presentationGeneration = 0;
    const spent: {
      content: PresentationBarrierSuccess | null;
      view: PresentationBarrierSuccess | null;
    } = { content: null, view: null };

    const close = (error?: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (quietFrame !== null) cancelAnimationFrame(quietFrame);
      quietFrame = null;
      unsubscribe();
      unsubscribeSettlement();
      presentationAbort?.abort();
      presentationAbort = null;
      for (const pendingId of ownedContentPendingIds) presentationPendingState.content.delete(pendingId);
      ownedContentPendingIds.clear();
      if (error) reject(error);
      // syncPending is "did the surface owner confirm this settlement". Answering false when only
      // the DOM went quiet and no surface owner confirmed turns "unknown" into "sync finished".
      else {
        resolve({
          settled: true,
          waitedMs: Math.round(performance.now() - started),
          animations: generation,
          settledAtUnixMs: presentationNowUnixMs(),
          // Name of the clock that produced this timestamp. Comparing it on one axis with another
          // producer's timestamp requires both to report the same name.
          clock: PRESENTATION_CLOCK,
          syncPending: !presentationSettled,
          presentation: { ...spent },
        });
      }
    };

    const inspect = () => {
      if (closed) return;
      if (layoutMotionFacts().active || layoutSettlementFacts(settlementKey).active) {
        if (quietFrame !== null) cancelAnimationFrame(quietFrame);
        quietFrame = null;
        presentationSettled = false;
        return;
      }
      const animations = liveLayoutAnimations();
      generation = Math.max(generation, animations.length);
      if (animations.length > 0) {
        if (quietFrame !== null) cancelAnimationFrame(quietFrame);
        quietFrame = null;
        presentationSettled = false;
      }
      if (animations.length === 0) {
        const pluginPresentation = pluginViewPresentationHost();
        if (!presentationSettled && (hasContentViewHost() || pluginPresentation)) {
          if (!presentationPending) {
            const timed = async <T>(
              owner: "content" | "view",
              labels: readonly string[],
              work: Promise<T>,
            ): Promise<PresentationBarrierSuccess> => {
              const at = performance.now();
              const pendingId = owner === "content" ? ++presentationPendingState.sequence : null;
              if (pendingId !== null) {
                ownedContentPendingIds.add(pendingId);
                presentationPendingState.content.set(pendingId, {
                  owner: "content", labels: [...labels], startedAtUnixMs: presentationNowUnixMs(),
                  startedAtPerformanceMs: at,
                });
              }
              try {
                const details = await work;
                const providerLabels = details && typeof details === "object"
                  && Array.isArray((details as { labels?: unknown }).labels)
                  ? (details as unknown as { labels: string[] }).labels
                  : labels;
                return {
                  owner,
                  status: "settled",
                  elapsedMs: Math.round(performance.now() - at),
                  labels: [...providerLabels],
                  ...(details === undefined ? {} : { details: structuredClone(details) }),
                };
              } catch (error) {
                throw new LayoutSettlementFailure({
                  command: "ui.layout.wait-settled",
                  barrier: owner,
                  elapsedMs: Math.round(performance.now() - at),
                  labels: [...labels],
                  providerError: serializePresentationProviderError(error),
                  status: layoutSettlementStatus(settlementKey),
                });
              } finally {
                if (pendingId !== null) {
                  ownedContentPendingIds.delete(pendingId);
                  presentationPendingState.content.delete(pendingId);
                }
              }
            };
            const labels = hasContentViewHost() ? visibleContentViewLabels() : [];
            // The barrier's deadline is this wait's, less a margin. The two had their own limits
            // and the barrier's was the longer one, so the side holding the reason never reached
            // its own limit — this wait expired first and answered TIMEOUT with a pending entry and
            // no cause (measured 2026-08-19, twice in one suite). The margin is what leaves room for
            // that reason to travel back before the timer here fires.
            const elapsedMs = performance.now() - started;
            const barrierLimitMs = Math.max(1, timeoutMs - elapsedMs - PRESENTATION_BARRIER_MARGIN_MS);
            const barrierAbort = new AbortController();
            presentationAbort = barrierAbort;
            const barriers = [
              ...(hasContentViewHost()
                ? [timed("content", labels, contentViewHost().presentationSettled(labels, barrierLimitMs)).then((receipt) => {
                  spent.content = receipt;
                })]
                : []),
              ...(pluginPresentation
                ? [timed("view", [], pluginPresentation.presentationSettled(barrierAbort.signal)).then((receipt) => {
                  spent.view = receipt;
                })]
                : []),
            ];
            const barrierGeneration = presentationGeneration;
            presentationPending = Promise.all(barriers)
              .then(
                () => {
                  if (barrierGeneration === presentationGeneration) presentationSettled = true;
                },
                (error) => {
                  if (barrierGeneration === presentationGeneration) {
                    close(error instanceof Error ? error : new Error(String(error)));
                  }
                },
              )
              .finally(() => {
                if (presentationAbort === barrierAbort) presentationAbort = null;
                presentationPending = null;
                inspect();
              });
          }
          return;
        }
        // React publishes the target DOM before its layout effect creates the FLIP animations.
        // A quiet microtask is therefore not a settled render. Confirm quietness once at the next
        // paint boundary; if an animation appeared, its own finished promise becomes the next
        // event. This is a finite render callback, not an interval or polling loop.
        if (quietFrame === null) {
          quietFrame = requestAnimationFrame(() => {
            quietFrame = null;
            if (closed) return;
            if (
              layoutMotionFacts().active ||
              layoutSettlementFacts(settlementKey).active ||
              liveLayoutAnimations().length > 0
            ) {
              inspect();
              return;
            }
            close();
          });
        }
        return;
      }
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(inspect);
    };

    const invalidatePresentationGeneration = () => {
      presentationAbort?.abort();
      presentationAbort = null;
      presentationGeneration += 1;
      presentationSettled = false;
      inspect();
    };
    unsubscribe = onLayoutMotion(invalidatePresentationGeneration);
    unsubscribeSettlement = onLayoutSettlement((event) => {
      if (settlementKey !== undefined && event.key !== settlementKey) return;
      invalidatePresentationGeneration();
    });
    timer = window.setTimeout(
      () => close(new LayoutSettlementTimeout(layoutSettlementStatus(settlementKey), timeoutMs)),
      timeoutMs,
    );
    inspect();
  });
}
