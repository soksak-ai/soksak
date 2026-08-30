import { moduleState } from "./moduleState";
import {
  arrangementMoves,
  moveOffsetPx,
  projectionGeometryChanged,
  type ArrangementMove,
} from "./railArrangement";
import { journalPreparingLayoutTransition } from "./layoutTransitionJournal";
import { tmsg } from "../i18n";
import type { LayoutPresentationStart } from "./layoutPresentationCoordinator";
import type { LayoutPresentationCandidateParticipant } from "./layoutPresentationCandidateCoordinator";

export interface LayoutMove {
  /** Public view identity. Core does not parse the native label string. */
  viewId: string;
  /** DOM FLIP start offset from the current position to the target position (old - new), CSS px. */
  dx: number;
}

export interface LayoutProjectionParticipant {
  viewId: string;
  kind: "projection-snap" | "bootstrap-snap";
}

export interface LayoutPanePresentationTarget {
  /** native-surface view identity declared by arrangement metadata. */
  viewId: string;
}

export interface LayoutChange {
  moves: readonly LayoutMove[];
  projectionParticipants: readonly LayoutProjectionParticipant[];
  panePresentationTargets: readonly LayoutPanePresentationTarget[];
  /** non-target PaneSurfaceHost identities to hold during the DOM commit. */
  paneSettlementParticipants: readonly LayoutPanePresentationTarget[];
}

export type LayoutTransitionMode = "glide" | "snap";

export type LayoutProjectionCommitTarget = Readonly<{
  stagedTarget: string;
  owner: "pane-bounds" | "direct-bounds" | "external-surface";
  frame: Readonly<{ x: number; y: number; w: number; h: number }>;
  sourceGeneration?: number;
}>;

export type LayoutProjectionCommitReceipt = Readonly<{
  transactionId: string;
  producer: "layout-adapter";
  targets: readonly LayoutProjectionCommitTarget[];
}>;

export type LayoutProjectionFailureReceipt = Readonly<{
  transactionId: string;
  stagedTarget: string;
  paneBoundsAck: unknown;
}>;

export type LayoutPreparationStageReceipt = Readonly<{
  /** Adapter-owned preparation substage identity. */
  id: string;
  startedAtUnixMs: number;
  completedAtUnixMs: number;
  status: "prepared";
  /** Owner facts the stage producer used for its verdict. */
  data?: unknown;
}>;

export type LayoutPreparationReceipt = Readonly<{
  producer: "layout-adapter";
  clock: string;
  stages: readonly LayoutPreparationStageReceipt[];
}>;

export class LayoutProjectionCommitFailure extends Error {
  readonly projectionFailure: LayoutProjectionFailureReceipt;

  constructor(receipt: LayoutProjectionFailureReceipt, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "LayoutProjectionCommitFailure";
    this.projectionFailure = structuredClone(receipt);
  }
}

/** Layout transaction that must be closed by exactly one of DOM commit or cancel after a successful prepare. */
export interface PreparedLayoutTransition {
  transactionId: string;
  mode: LayoutTransitionMode;
  /** When true, the target DOM is pinned at the start point until the start receipt. */
  requiresSharedStart: boolean;
  /** native owner identity the framework adapter actually staged. A DOM-only transaction gets an empty array. */
  stagedTargets: readonly string[];
  /** Per-owner completion intervals of the adapter preparation. When supplied, the public journal preserves it verbatim. */
  preparation?: LayoutPreparationReceipt;
  /** Starts every prepared participant in one producer-owned display epoch. */
  start(domParticipant?: LayoutPresentationCandidateParticipant): Promise<LayoutPresentationStart | null>;
  /** Right after the target DOM actually commits, compares the external surface ledger against the final rect. */
  commit(): Promise<void | LayoutProjectionCommitReceipt>;
  /** Reverts to the old DOM rect when the target changes during preparation or the component unmounts. */
  cancel(): void;
}

export interface LayoutTransitionHost {
  /** Before the target DOM commit, the framework prepares the moves and the projection-snap owners. */
  prepareChange(
    change: LayoutChange,
    identity: { transactionId: string },
    signal?: AbortSignal,
  ): Promise<PreparedLayoutTransition>;
}

export interface LayoutViewGroup {
  id: string;
  viewIds: readonly string[];
  /** native-surface view identities actually displayed in this group. */
  panePresentationViewIds: readonly string[];
}

/** Workspaces the logical moves of a group layout into CSS px moves per public view identity, exactly once. */
export function viewLayoutMoves(
  moves: readonly ArrangementMove[],
  groups: readonly LayoutViewGroup[],
  hostWidthPx: number,
  railWidthPx: number,
): LayoutMove[] {
  if (!Number.isFinite(hostWidthPx) || hostWidthPx <= 0) {
    throw new Error(tmsg("layout.host.widthInvalid", { width: hostWidthPx }));
  }
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  return moves.flatMap((move) => {
    const group = groupsById.get(move.id);
    if (!group) return [];
    const dx = moveOffsetPx(move, hostWidthPx, railWidthPx);
    return group.viewIds.map((viewId) => ({ viewId, dx }));
  });
}

/** Translation and snap-only projection ownership derived from the same solved arrangements. */
export function viewLayoutChange(
  from: { railPresent: boolean; station: number; focusId: string | null; cells: Array<{ id: string; rect: { left: number; top: number; width: number; height: number } }> },
  to: { railPresent: boolean; station: number; focusId: string | null; cells: Array<{ id: string; rect: { left: number; top: number; width: number; height: number } }> },
  groups: readonly LayoutViewGroup[],
  hostWidthPx: number,
  railWidthPx: number,
): LayoutChange {
  const moves = viewLayoutMoves(
    arrangementMoves(from, to),
    groups,
    hostWidthPx,
    railWidthPx,
  );
  const affected = new Set(moves.map(({ viewId }) => viewId));
  const paneParticipants = groups.flatMap(({ panePresentationViewIds }) => panePresentationViewIds);
  const settlementParticipants = (targets: readonly LayoutPanePresentationTarget[]) => {
    const targetIds = new Set(targets.map(({ viewId }) => viewId));
    return [...new Set(paneParticipants)]
      .filter((viewId) => !targetIds.has(viewId))
      .map((viewId) => ({ viewId }));
  };
  // Rail presence changes every pane's physical box even when its percentage cell is byte-for-byte
  // identical: the inserted width appears or disappears from the shared row. Treat it as one
  // projection shape transaction so browser and terminal native surfaces are staged before the DOM
  // width commit instead of showing one mismatched frame.
  const railPresenceChanged = from.railPresent !== to.railPresent;
  const projectionShapeChanged = railPresenceChanged
    || from.cells.length !== to.cells.length || from.cells.some((cell) => {
    const next = to.cells.find(({ id }) => id === cell.id);
    return !next
      || !Object.is(cell.rect.top, next.rect.top)
      || !Object.is(cell.rect.width, next.rect.width)
      || !Object.is(cell.rect.height, next.rect.height);
  });
  if (!projectionShapeChanged || !projectionGeometryChanged(from, to)) {
    const panePresentationTargets = groups.flatMap(({ panePresentationViewIds }) =>
      panePresentationViewIds.filter((viewId) => affected.has(viewId)).map((viewId) => ({ viewId })));
    return {
      moves,
      projectionParticipants: [],
      panePresentationTargets,
      paneSettlementParticipants: settlementParticipants(panePresentationTargets),
    };
  }
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const projectionParticipants = to.cells.flatMap((cell) => {
    const previous = from.cells.find(({ id }) => id === cell.id);
    const shapeChanged = railPresenceChanged || !previous
      || !Object.is(previous.rect.top, cell.rect.top)
      || !Object.is(previous.rect.width, cell.rect.width)
      || !Object.is(previous.rect.height, cell.rect.height);
    if (!shapeChanged) return [];
    return (groupsById.get(cell.id)?.panePresentationViewIds ?? []).map((viewId) => ({
      viewId,
      kind: "projection-snap" as const,
    }));
  });
  const projected = new Set(projectionParticipants.map(({ viewId }) => viewId));
  const panePresentationTargets = [...projected].map((viewId) => ({ viewId }));
  return {
    moves,
    projectionParticipants,
    panePresentationTargets,
    paneSettlementParticipants: settlementParticipants(panePresentationTargets),
  };
}

const registered = moduleState("lib/layoutTransitionHost#registered", () => ({
  host: null as LayoutTransitionHost | null,
}));

export function registerLayoutTransitionHost(host: LayoutTransitionHost): void {
  registered.host = host;
}

/** Not installed = content follows the DOM layout directly, so the existing glide is correct. */
export async function prepareLayoutMove(
  moves: readonly LayoutMove[],
): Promise<PreparedLayoutTransition> {
  return prepareLayoutChange({
    moves,
    projectionParticipants: [],
    panePresentationTargets: [],
    paneSettlementParticipants: [],
  });
}

export async function prepareLayoutChange(
  change: LayoutChange,
  signal?: AbortSignal,
): Promise<PreparedLayoutTransition> {
  const identity = { transactionId: `layout-${layoutTransitionIdentity.next++}` };
  const journal = journalPreparingLayoutTransition(change, identity);
  try {
    const prepared = await (registered.host
      ? (signal
          ? registered.host.prepareChange(change, identity, signal)
          : registered.host.prepareChange(change, identity))
      : Promise.resolve({
      transactionId: identity.transactionId,
      mode: "glide",
      requiresSharedStart: false,
      stagedTargets: [],
      start: async () => null,
      commit: async () => {},
      cancel: () => {},
        } as PreparedLayoutTransition));
    if (prepared.transactionId !== identity.transactionId) {
      prepared.cancel();
      throw new Error(tmsg("layout.transition.identityChanged", { transactionId: identity.transactionId }));
    }
    if (prepared.mode === "snap" && prepared.requiresSharedStart) {
      prepared.cancel();
      throw new Error(tmsg("layout.transition.snapSharedStart", { transactionId: identity.transactionId }));
    }
    const targetPattern = /^(direct|pane):[^:\s]+$/;
    if (
      prepared.stagedTargets.some((target) => !targetPattern.test(target))
      || new Set(prepared.stagedTargets).size !== prepared.stagedTargets.length
    ) {
      prepared.cancel();
      throw new Error(tmsg("layout.transition.stagedTargetInvalid", { transactionId: identity.transactionId }));
    }
    return journal.bind(prepared);
  } catch (error) {
    journal.fail(error);
    throw error;
  }
}

export function __resetLayoutTransitionHostForTest(): void {
  registered.host = null;
  layoutTransitionIdentity.next = 1;
}

const layoutTransitionIdentity = moduleState("lib/layoutTransitionHost#identity", () => ({ next: 1 }));
