// Arrangement phase — the phase owns what is on screen.
//
// There is exactly one phase tracker here. Three tracked it separately before (focus swap phase,
// rail travel geometry, rail presentation generation) — so when switching and travel overlapped in
// one click they read different start points and drifted. One moves list drawn from one solution
// holds both axes (array swap, insertion point), and a projection that changes only cell
// membership/size without motion, such as maximize, is owned by a separate snap participant.
//
// And **the phase owns the display**: a new solution arriving mid-travel does not replace the
// display, it goes into a queue (depth 1). Replacing the display immediately makes the running
// animation's start offset reinterpret on the CSS variable update, so the element jumps by the
// remaining progress (up to the sum of two travel distances). The queue removes that defect
// structurally — the next journey departs for the newest target after the first one ends, so it is
// always smooth, and however many clicks arrive there are at most two phases (the middle ones fold).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  arrangementMoves,
  projectionGeometryChanged,
  type Arrangement,
  type ArrangementMove,
} from "../lib/railArrangement";
import { scheduleMotion, scheduleMotionAtUnixUs } from "../lib/motionDebug";
import { railTravelDeclaredMs } from "../lib/railMotion";
import { redeliverViewFocusIfLost } from "../plugins/viewFocus";
import type { PreparedLayoutTransition } from "../lib/layoutTransitionHost";
import type { LayoutPresentationCandidateParticipant } from "../lib/layoutPresentationCandidateCoordinator";
import { requestedLayoutRevision, settleLayout } from "../lib/layoutSettlement";
import {
  claimLayoutTransitionIntent,
  finishLayoutTransitionIntent,
} from "../lib/layoutTransitionIntent";
import {
  bindLayoutTransactionSettlementIfPresent,
  finishLayoutTransactionSettlement,
} from "../lib/layoutTransitionJournal";
import {
  publishLayoutArrangementPhase,
  removeLayoutArrangementPhase,
} from "../lib/layoutArrangementPhase";
import { emitPluginEvent } from "../plugins/hooks";
import type { SplitTree } from "../state/splitTree";

function valuesById<L extends { id: string }>(tree: SplitTree<L>, values = new Map<string, L>()): Map<string, L> {
  if (tree.type === "leaf") values.set(tree.value.id, tree.value);
  else for (const child of tree.children) valuesById(child, values);
  return values;
}

function rebindLayoutValues<L extends { id: string }>(tree: SplitTree<L>, values: Map<string, L>): SplitTree<L> {
  if (tree.type === "leaf") return { ...tree, value: values.get(tree.value.id) ?? tree.value };
  return { ...tree, children: tree.children.map((child) => rebindLayoutValues(child, values)) };
}

function rebindArrangementContent<L extends { id: string }>(
  displayed: Arrangement<L>,
  current: Arrangement<L>,
): Arrangement<L> {
  return {
    ...displayed,
    displayLayout: rebindLayoutValues(displayed.displayLayout, valuesById(current.displayLayout)),
  };
}

export interface ArrangementPhase<L> {
  /** The arrangement on screen now — the single truth for render (during a phase it holds the phase target). */
  displayed: Arrangement<L> | null;
  /** Phase start arrangement. Equal to displayed while stopped. */
  from: Arrangement<L> | null;
  /** Only panels that actually move. Empty means this is not a phase. */
  moves: ArrangementMove[];
  traveling: boolean;
  /** A framework-external surface is preparing bounds before the target DOM commit. */
  preparing: boolean;
  /** The target DOM is committed, but the producer start receipt shared with the external surface is pending. */
  starting: boolean;
  /** Exact ownership state while the snap target DOM is replaced atomically with the external projection commit. */
  replacing: boolean;
  /**
   * Mode of this journey — glide (panel FLIP + a leaving slot and an arriving slot) or not. Fixed
   * **once at the start** and unchanged for the whole phase. Changing it midway switches the rail
   * representation between one sheet and two, and the sidebar rendered in the one-sheet form is
   * pushed into the leaving slot after the new projection commits (it then closes while holding the
   * new projection — measured defect).
   */
  glide: boolean;
  startAtUnixUs?: number;
  /** Accept the next solution without a journey (hand drag landing — the hand already moved it). */
  rebase: () => void;
}

interface PhaseState<L> {
  from: Arrangement<L> | null;
  displayed: Arrangement<L> | null;
  scopeId: string;
  contentKey: string;
  /** Journey mode frozen at start. Meaningless while stopped. */
  glide: boolean;
  preparing: boolean;
  starting: boolean;
  startAtUnixUs?: number;
}

/** Solution signature for the phase re-arm decision — a new object arrives each render, so compare by value. */
/**
 * Signature of this solution — counts **everything the phase holds**.
 *
 * The phase animates geometry only but **holds the whole solution**, and consumers also read the
 * facts focus determines in that solution (which plane it is attached to, the plane wedged between,
 * whether adjacency came from a swap). Signing geometry alone makes a solution that changed only
 * focus look identical, so **it is not accepted at all** — those facts stay at the old values
 * forever.
 *
 * Measured (2026-08-02): (1) moving focus in travel mode (by definition nothing moves) left the
 * wedged plane idle; (2) activating a plane already next to the rail left the attachment on the old
 * plane and the border width did not return. Both are the same spot. A solution whose geometry does
 * not move is applied below **immediately, without a journey**, so an exact signature takes that
 * path.
 */
function arrangementKey<L>(a: Arrangement<L> | null): string {
  if (!a) return "";
  const cells = a.cells
    .map((c) => `${c.id}@${c.rect.left.toFixed(3)}`)
    .join(",");
  return [
    a.station.toFixed(3),
    cells,
    a.focusId ?? "",
    a.swapped ? "1" : "0",
    a.betweenIds.join("+"),
    a.maximizedId ?? "",
  ].join("|");
}

export function useArrangementPhase<L extends { id: string }>(
  current: Arrangement<L> | null,
  /** Plane identity (space + the clean line set). A split or merge that changes the line set makes a new plane. */
  scopeId: string,
  /**
   * Content identity (per-panel view composition) — the phase holds **geometry only**. Judging a
   * content change (view opened, tab switched) by the geometry signature alone leaves the display on
   * the old tree and the new view never appears (real incident). When geometry is unchanged, a
   * content change is applied immediately without a journey.
   */
  contentKey: string,
  /**
   * Can this journey run as a glide (can every moving hole surface be covered by a stand-in)?
   * Evaluated **once** at phase start and the answer is fixed for the whole journey — re-evaluating
   * each render changes the representation shape mid-phase. Omitted means always glide.
   */
  canGlide?: (from: Arrangement<L>, to: Arrangement<L>) => boolean,
  /**
   * Prepares framework-external surfaces before the target DOM commit. `snap` places the DOM in one
   * step once preparation completes; `glide` starts the existing FLIP. Omitted means a DOM glide
   * with no external surface to prepare.
   */
  prepareTravel?: (
    from: Arrangement<L>,
    to: Arrangement<L>,
  ) => Promise<PreparedLayoutTransition>,
  /** ACK key for the workspace-scoped layout revision published by the state mutation. */
  settlementKey?: string,
  domCandidateParticipant?: LayoutPresentationCandidateParticipant,
): ArrangementPhase<L> {
  const [phase, setPhase] = useState<PhaseState<L>>({
    from: current,
    displayed: current,
    scopeId,
    contentKey,
    glide: true,
    preparing: false,
    starting: false,
    startAtUnixUs: undefined,
  });

  // Newest value at commit time — capturing at arm time pinned a transient value (placement not yet
  // loaded, and the like) as the reference point, and every later focus change resumed a phantom
  // journey (real incident).
  const latest = useRef(current);
  latest.current = current;
  const latestScope = useRef(scopeId);
  latestScope.current = scopeId;
  const latestContent = useRef(contentKey);
  latestContent.current = contentKey;
  const latestCanGlide = useRef(canGlide);
  latestCanGlide.current = canGlide;
  const latestPrepareTravel = useRef(prepareTravel);
  latestPrepareTravel.current = prepareTravel;
  /** Mode decision at journey start — this is the only place that evaluates it. */
  const decideGlide = (from: Arrangement<L> | null, to: Arrangement<L> | null): boolean =>
    from && to ? (latestCanGlide.current?.(from, to) ?? true) : true;
  /** Newest solution that arrived mid-travel (depth 1) — the display switches after the journey ends. */
  const queued = useRef<Arrangement<L> | null>(null);
  const preparation = useRef({ serial: 0, key: "" });
  const lastFailure = useRef<{ targetKey: string; message: string } | null>(null);
  const pendingCommit = useRef<{
    prepared: PreparedLayoutTransition;
    settlementRevision: number | null;
    settlementBound: boolean;
    intentOwnerKey: string | null;
    intentRevision: number | null;
  } | null>(null);
  const travelingIntent = useRef<{ ownerKey: string; revision: number } | null>(null);
  const travelingSettlement = useRef<{ ownerKey: string; revision: number } | null>(null);
  const travelingTransaction = useRef<string | null>(null);
  const presentationCommits = useRef(0);
  const mounted = useRef(true);
  const [, publishPresentationCommit] = useState(0);
  /** Take the next solution without a journey — for when a hand drag already moved it to that position. */
  const acceptWithoutTravel = useRef(false);

  const projectionBoundary = !!phase.displayed && !!current
    && phase.displayed.maximizedId !== current.maximizedId;
  const samePlane = phase.scopeId === scopeId || projectionBoundary;
  const moves =
    phase.displayed && phase.from && samePlane
      ? arrangementMoves(phase.from, phase.displayed)
      : [];
  const traveling = moves.length > 0;

  /** Set the display to the newest solution immediately (no journey) — re-anchor, content change, and drag landing share this path. */
  const adopt = useCallback(() => {
    queued.current = null;
    setPhase((p) => ({
      from: latest.current,
      displayed: latest.current,
      scopeId: latestScope.current,
      contentKey: latestContent.current,
      glide: p.glide,
      preparing: false,
      starting: false,
      startAtUnixUs: undefined,
    }));
  }, []);

  const rebase = useCallback(() => {
    acceptWithoutTravel.current = true;
    adopt();
  }, [adopt]);

  const currentKey = arrangementKey(current);
  const displayedKey = arrangementKey(phase.displayed);
  // The store opens a revision, then publishes the new workspace. The exact token is taken only on a
  // render where the external arrangement identity changed, so an internal hook rerender cannot
  // mistake a revision opened after that for one of the same arrangement.
  const settlementIdentity = `${scopeId}\u0000${contentKey}\u0000${currentKey}`;
  const observedSettlement = useRef({ identity: "", revision: 0 });
  const settlementFence = useRef<{ identity: string; revision: number } | null>(null);
  if (observedSettlement.current.identity !== settlementIdentity) {
    observedSettlement.current = {
      identity: settlementIdentity,
      revision: settlementKey ? requestedLayoutRevision(settlementKey) : 0,
    };
    settlementFence.current = null;
  } else if (!settlementFence.current && settlementKey) {
    // An external store publish with identical geometry consumes a revision too. An identity already
    // owned by a transaction is fenced, so that transaction's internal rerender cannot steal a later
    // revision and ACK it.
    observedSettlement.current.revision = requestedLayoutRevision(settlementKey);
  }
  const currentSettlementRevision = observedSettlement.current.revision;

  // No automatic retry while a failed target is held with no state change. Once a different target is
  // actually adopted, that failure key is no longer the current intent and is released; a new
  // revision that later returns to the same target must be able to open a new prepare transaction.
  if (!phase.preparing && preparation.current.key && preparation.current.key !== currentKey) {
    preparation.current.key = "";
  }

  useLayoutEffect(() => {
    if (!settlementKey) return;
    const identity = (value: Arrangement<L> | null, key: string) => ({
      key,
      station: value?.station ?? null,
      focusId: value?.focusId ?? null,
    });
    const blocked = lastFailure.current?.targetKey === currentKey
      && preparation.current.key === currentKey;
    publishLayoutArrangementPhase({
      ownerKey: settlementKey,
      current: identity(current, currentKey),
      displayed: identity(phase.displayed, displayedKey),
      phase: blocked
        ? "blocked"
        : phase.preparing
          ? "preparing"
          : phase.starting
            ? "starting"
            : traveling
              ? "traveling"
              : "idle",
      preparationTargetKey: preparation.current.key || null,
      lastFailure: lastFailure.current ? { ...lastFailure.current } : null,
    });
  });

  useEffect(() => () => {
    if (settlementKey) removeLayoutArrangementPhase(settlementKey);
  }, [settlementKey]);

  // Handling a new solution — plane changed: re-anchor immediately; geometry unchanged: apply
  // immediately; mid-travel: queue; stopped with geometry changed: start a journey.
  useLayoutEffect(() => {
    if (!samePlane) {
      // Applying the old line set's station to the new plane runs the rail through a panel — the
      // start geometry is not consumed and the new plane is used as is.
      adopt();
      return;
    }
    const contentChanged = phase.contentKey !== contentKey;
    // A tab switch during an active rail journey changes pane content, not that journey's geometry.
    // Apply the newest pane values to the displayed tree while retaining from/displayed geometry,
    // timer, transaction intent and settlement ownership. Replacing the whole phase here abandons
    // the open intent and leaves every later focus change queued behind it.
    if (traveling && contentChanged && currentKey === displayedKey && phase.displayed && current) {
      setPhase((p) => p.displayed ? {
        ...p,
        displayed: rebindArrangementContent(p.displayed, current),
        contentKey,
      } : p);
      return;
    }
    if (currentKey === displayedKey && !contentChanged) return;
    if (acceptWithoutTravel.current) {
      acceptWithoutTravel.current = false;
      adopt();
      return;
    }
    // Unchanged geometry is not a journey — content (view composition) goes to the newest at once.
    // The phase holds geometry only.
    const geometryChanged = current && phase.displayed
      ? projectionGeometryChanged(phase.displayed, current)
      : false;
    if (!geometryChanged) {
      adopt();
      return;
    }
    if (traveling) {
      queued.current = latest.current; // Mid-travel — leave the displayed value alone and keep only the newest target.
      return;
    }
    const from = phase.displayed;
    const target = latest.current;
    const prepare = latestPrepareTravel.current;
    const intentPrepared = settlementKey && currentSettlementRevision > 0
      ? claimLayoutTransitionIntent(settlementKey, currentSettlementRevision)
      : null;
    const intentRevision = intentPrepared ? currentSettlementRevision : null;
    if ((prepare || intentPrepared) && from && target) {
      if (preparation.current.key === currentKey) return;
      const serial = ++preparation.current.serial;
      preparation.current.key = currentKey;
      settlementFence.current = currentSettlementRevision > 0
        ? { identity: settlementIdentity, revision: currentSettlementRevision }
        : null;
      lastFailure.current = null;
      setPhase((p) => ({ ...p, preparing: true }));
      void (intentPrepared ?? prepare!(from, target))
        .then(async (prepared) => {
          if (preparation.current.serial !== serial) {
            prepared.cancel();
            if (settlementKey && intentRevision) {
              finishLayoutTransitionIntent(settlementKey, intentRevision, { reason: "stale-preparation" });
            }
            return;
          }
          preparation.current.key = "";
          // A newer solution arriving during preparation already has its own prepare transaction
          // running under a separate serial.
          if (arrangementKey(latest.current) !== currentKey) {
            prepared.cancel();
            if (settlementKey && intentRevision) {
              finishLayoutTransitionIntent(settlementKey, intentRevision, { reason: "stale-target" });
            }
            return;
          }
          pendingCommit.current?.prepared.cancel();
          const settlementRevision = settlementKey && currentSettlementRevision > 0
            ? currentSettlementRevision
            : null;
          const settlementBound = prepared.mode === "snap" && settlementKey && settlementRevision
            ? bindLayoutTransactionSettlementIfPresent(prepared.transactionId, {
                ownerKey: settlementKey,
                revision: settlementRevision,
              })
            : false;
          pendingCommit.current = {
            prepared,
            settlementRevision,
            settlementBound,
            intentOwnerKey: intentPrepared ? (settlementKey ?? null) : null,
            intentRevision,
          };
          if (prepared.mode === "snap") {
            setPhase(() => ({
              from: target,
              displayed: target,
              scopeId: latestScope.current,
              contentKey: latestContent.current,
              glide: false,
              preparing: false,
              starting: false,
              startAtUnixUs: undefined,
            }));
            redeliverViewFocusIfLost();
            return;
          }
          setPhase((p) => ({
            from: p.displayed,
            displayed: target,
            scopeId: latestScope.current,
            contentKey: latestContent.current,
            glide: decideGlide(p.displayed, target),
            preparing: false,
            starting: prepared.requiresSharedStart,
            startAtUnixUs: undefined,
          }));
        })
        .catch((error) => {
          if (preparation.current.serial !== serial) return;
          if (settlementKey && intentRevision) {
            finishLayoutTransitionIntent(settlementKey, intentRevision, { reason: "prepare-failed" });
          }
          // The same target is not retried forever on state changes alone. A new target changes the
          // key and preparation runs again normally. A failed transaction preserves the old DOM
          // arrangement as is.
          preparation.current.key = currentKey;
          lastFailure.current = {
            targetKey: currentKey,
            message: error instanceof Error ? error.message : String(error),
          };
          setPhase((p) => ({ ...p, preparing: false }));
          console.error("[layout] target arrangement prepare failed", error);
        });
      return;
    }
    setPhase((p) => ({
      from: p.displayed,
      displayed: target,
      scopeId: latestScope.current,
      contentKey: latestContent.current,
      glide: decideGlide(p.displayed, target),
      preparing: false,
      starting: false,
      startAtUnixUs: undefined,
    }));
    // current is a new object each render — only the value signatures (currentKey, contentKey) are
    // stable deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentKey,
    displayedKey,
    contentKey,
    phase.contentKey,
    samePlane,
    traveling,
    adopt,
    currentSettlementRevision,
    settlementKey,
  ]);

  // Closes the prepare transaction right after React commits the target DOM and before the browser
  // paints that frame. Tauri holds its lock until this point so an old reflow cannot overwrite the
  // precommit bounds.
  useLayoutEffect(() => {
    const pending = pendingCommit.current;
    if (!pending) return;
    pendingCommit.current = null;
    const {
      prepared,
      settlementRevision,
      settlementBound,
      intentOwnerKey,
      intentRevision,
    } = pending;
    presentationCommits.current += 1;
    void (async () => {
      const receipt = prepared.requiresSharedStart
        ? await prepared.start(domCandidateParticipant)
        : null;
      await prepared.commit();
      return receipt;
    })()
      .then((receipt) => {
        if (prepared.mode === "snap" && settlementKey && settlementRevision) {
          settleLayout(settlementKey, settlementRevision);
          if (settlementBound) {
            finishLayoutTransactionSettlement(prepared.transactionId, {
              ownerKey: settlementKey,
              revision: settlementRevision,
              status: "settled",
            });
          }
        }
        if (intentOwnerKey && intentRevision) {
          if (prepared.mode === "snap") {
            finishLayoutTransitionIntent(intentOwnerKey, intentRevision, { reason: "snap-committed" });
          } else {
            travelingIntent.current = { ownerKey: intentOwnerKey, revision: intentRevision };
          }
        }
        if (prepared.mode === "glide" && settlementKey && settlementRevision) {
          travelingSettlement.current = { ownerKey: settlementKey, revision: settlementRevision };
        }
        if (prepared.mode === "glide") travelingTransaction.current = prepared.transactionId;
        if (!receipt || !mounted.current) return;
        setPhase((current) => current.displayed === phase.displayed
          ? { ...current, starting: false, startAtUnixUs: receipt.startAtUnixUs }
          : current);
      })
      .catch((error) => {
        if (intentOwnerKey && intentRevision) {
          finishLayoutTransitionIntent(intentOwnerKey, intentRevision, {
            reason: "commit-failed",
            transactionId: prepared.transactionId,
            failure: error instanceof Error ? error.message : String(error),
          });
        }
        if (settlementBound && settlementKey && settlementRevision) {
          finishLayoutTransactionSettlement(prepared.transactionId, {
            ownerKey: settlementKey,
            revision: settlementRevision,
            status: "failed",
          });
        }
        prepared.cancel();
        const targetKey = arrangementKey(latest.current);
        preparation.current.key = targetKey;
        lastFailure.current = {
          targetKey,
          message: error instanceof Error ? error.message : String(error),
        };
        if (mounted.current) {
          setPhase((current) => current.displayed === phase.displayed
            ? {
                ...current,
                displayed: current.from,
                preparing: false,
                starting: false,
                startAtUnixUs: undefined,
              }
            : current);
        }
        console.error("[layout] target arrangement commit check failed", error);
      })
      .finally(() => {
        presentationCommits.current = Math.max(0, presentationCommits.current - 1);
        if (mounted.current) publishPresentationCommit((revision) => revision + 1);
      });
  }, [phase.displayed, domCandidateParticipant, settlementKey]);

  useEffect(() => () => {
    mounted.current = false;
    const pending = pendingCommit.current;
    pending?.prepared.cancel();
    if (pending?.intentOwnerKey && pending.intentRevision) {
      finishLayoutTransitionIntent(pending.intentOwnerKey, pending.intentRevision, { reason: "unmounted-pending" });
    }
    pendingCommit.current = null;
    const activeTravel = travelingIntent.current;
    const activeTransaction = travelingTransaction.current;
    travelingIntent.current = null;
    travelingSettlement.current = null;
    travelingTransaction.current = null;
    if (activeTransaction) {
      emitPluginEvent("layout.travel-finished", { transactionId: activeTransaction, status: "cancelled" });
    }
    if (activeTravel) {
      finishLayoutTransitionIntent(activeTravel.ownerKey, activeTravel.revision, { reason: "unmounted-travel" });
    }
  }, []);

  // Journey end — a queued target starts the next journey from this position.
  useEffect(() => {
    if (!traveling || phase.starting) return;
    const finish = () => {
      const activeTravel = travelingIntent.current;
      travelingIntent.current = null;
      const activeSettlement = travelingSettlement.current;
      const activeTransaction = travelingTransaction.current;
      travelingSettlement.current = null;
      travelingTransaction.current = null;
      if (activeSettlement) {
        settleLayout(activeSettlement.ownerKey, activeSettlement.revision);
      }
      if (activeTravel) {
        finishLayoutTransitionIntent(activeTravel.ownerKey, activeTravel.revision, { reason: "visual-landing" });
      }
      if (activeTransaction) {
        emitPluginEvent("layout.travel-finished", { transactionId: activeTransaction, status: "landed" });
      }
      setPhase((p) => {
        const next = queued.current;
        queued.current = null;
        // The next target is prepared again through the normal entry path after this landing.
        // Changing displayed here bypasses Tauri's precommit bounds transaction.
        void next;
        const landed = p.displayed
          && latest.current
          && arrangementKey(p.displayed) === arrangementKey(latest.current)
          && p.contentKey === latestContent.current
          ? latest.current
          : p.displayed;
        return {
          from: landed,
          displayed: landed,
          scopeId: latestScope.current,
          contentKey: latestContent.current,
          glide: p.glide,
          preparing: false,
          starting: false,
          startAtUnixUs: undefined,
        };
      });
      // Redelivers the input focus dropped by the rearrangement at landing — the seam for the defect
      // where only the outside (group active) applies and the inner (widget) focus never arrives.
      redeliverViewFocusIfLost();
    };
    const durationMs = railTravelDeclaredMs();
    const cancel = phase.startAtUnixUs === undefined
      ? scheduleMotion(durationMs, finish)
      : scheduleMotionAtUnixUs(phase.startAtUnixUs, durationMs, finish);
    return cancel;
  }, [traveling, phase.starting, phase.startAtUnixUs]);

  // The public ACK for a state mutation is emitted only after the final solution is the displayed
  // solution and both preparation and motion are closed.
  useLayoutEffect(() => {
    if (
      !settlementKey
      || phase.preparing
      || traveling
      || presentationCommits.current > 0
      || currentKey !== displayedKey
    ) return;
    const revision = currentSettlementRevision;
    if (revision > 0) settleLayout(settlementKey, revision);
  });

  return {
    displayed: phase.displayed,
    from: traveling ? phase.from : phase.displayed,
    moves,
    traveling,
    preparing: phase.preparing,
    starting: phase.starting,
    replacing: pendingCommit.current?.prepared.mode === "snap",
    glide: phase.glide,
    startAtUnixUs: phase.startAtUnixUs,
    rebase,
  };
}
