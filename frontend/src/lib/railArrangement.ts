// Arrangement solver — the left rail position and the panel arrangement are a pure function of
// (grid, focus).
//
// This computation exists only here. If station, switching, produced adjacency, and move delta are not
// taken from the same solution they disagree, and that disagreement appears as a "works sometimes,
// fails sometimes" defect (scattered recomputation was the actual cause). Consumers read the solution
// and never recompute it.
//
// Invariant: a solution's station is always a clean line over that solution's cells (it crosses no
// panel). That is what lets consumers use projectRailCssRect safely.

import { SplitPane } from "split-pane";
import type { CardInit, SplitPaneState } from "split-pane";
import { flowRailBoundBox } from "./railBoundBox";
import {
  classifyRailRelation,
  type RailRelationSide,
} from "./railLinkShape";
import type { Rect } from "./splitPaneGeometry";

type GridLayout<L> = Omit<SplitPaneState, "cards"> & {
  cards: Array<Omit<CardInit, "data"> & { data: L }>;
};

function cellsOf<L>(layout: GridLayout<L>): Array<{ value: L; rect: Rect }> {
  const grid = new SplitPane(layout, { width: 100, height: 100, gap: 0, minSize: 0 });
  return layout.cards.map((card) => {
    const rect = grid.rect(card.id)!;
    return { value: card.data, rect: { left: rect.x, top: rect.y, width: rect.w, height: rect.h } };
  });
}
import {
  RAIL_EPSILON,
  cleanRailLines,
  isCleanRailStation,
  projectRailCssRect,
  projectRailCssSpan,
  snapRailStation,
  type RailPlacement,
} from "./railPlacement";

const FULL_RECT: Rect = { left: 0, top: 0, width: 100, height: 100 };

// Lower bound for move detection — below this is float error left by resize and equalization. Counting
// that error as a move opens a phantom travel phase on every tab switch, and every surface on screen
// pays the phase cost (real incident).
const MOVE_EPSILON_PCT = 0.05;
const MOVE_EPSILON_RAIL = 0.005;

export interface ArrangementCell {
  id: string;
  rect: Rect;
}

export interface Arrangement<L> {
  /** Whether this solution contains the rail. Transition preparation reads this state rather than a render closure. */
  railPresent: boolean;
  /** Logical vertical line (0..100) where the rail is inserted. Always clean over the solution's cells. */
  station: number;
  cleanLines: number[];
  /** Arrangement to render. Without switching, object identity matches the canonical tree. */
  displayLayout: GridLayout<L>;
  /** Whether adjacency in FLOW was produced by a swap — the single basis for the dashed seam. Always false for PIN. */
  swapped: boolean;
  cells: ArrangementCell[];
  focusId: string | null;
  /**
   * Panes wedged **between** the rail and the focused pane — non-empty only when the rail could not
   * reach that pane.
   *
   * PIN fixes station and pane together, so it answers with the panes between it and a detached focus.
   * FLOW is also declared not to rearrange panes and answers the same fact when the focus line is
   * blocked. Consumers choose the presentation; this list itself is a pure geometric fact.
   */
  betweenIds: string[];
  /**
   * Whether this solution renders a maximization — that panel id, or null.
   *
   * A consumer **must not re-read "is it maximized" from raw state.** station and rect are decided
   * together by this solution, and a maximization flag from a different point in time puts a new rect on
   * an old line; that combination is a panel crossing the rail, so the projection throws
   * (projectRailCssRect). A throw during render erases the whole tree, not one screen (measured
   * 2026-07-29: maximizing the browser in a half split threw `rail station 50 crosses panel 0..100`,
   * exposed nodes went 64 → 0, the window went blank).
   *
   * So the solution emits this fact too — only the triple from one solution (station, cells,
   * maximizedId) is mixed.
   */
  maximizedId: string | null;
}

export interface ArrangementMove {
  id: string;
  /** Move in % of container width (arrangement swap). */
  dLeftPct: number;
  /** Move in multiples of rail width (insertion point change). */
  dRailUnits: number;
}

/** Physical rail width of the solution currently displayed by the phase. */
export function presentedRailWidth<L>(
  arrangement: Pick<Arrangement<L>, "railPresent"> | null | undefined,
  width: number,
): number {
  return arrangement?.railPresent ? width : 0;
}

export type RailRelationBorderMode = "union" | "independent" | "none";

/**
 * The relation state the screen actually applied between rail and tab.
 *
 * No nullable object. "No relation" must also be published with a none/0 identity so it stays distinct
 * from an unmeasured DOM. relationId holds only a valid binding identity inside the space. side and
 * borderMode express geometry and border branching separately, so maximize/restore and resize are not
 * mistaken for a change of tab identity.
 */
/** Why this pane is the one the rail is grouped with. `focus` is the rule; `fallback` is a space
 *  whose focused pane is not on the screen's solution, which is a state and not a choice. Reading
 *  it is how a grouping that followed the wrong rule is reported rather than looked at. */
export type RailRelationSource = "focus" | "fallback" | "none";

export interface RailRelationState {
  boundTabId: string | null;
  boundPaneId: string | null;
  /** Which rule chose the bound pane. Without it a wrong grouping is a guess about three rules. */
  source: RailRelationSource;
  relationId: string;
  placement: RailPlacement["mode"];
  connected: boolean;
  side: RailRelationSide;
  borderMode: RailRelationBorderMode;
  pathCount: 0 | 1 | 2;
}

/** Returns the public state together with the resolved targets, so the renderer consumes the same pane, tab, and box as the state. */
export interface EffectiveRailRelation<
  L,
  T,
> {
  state: RailRelationState;
  boundPane: L | null;
  boundTab: T | null;
  targetRect: Rect | null;
}

export interface PresentedRailRelation<L, T> extends EffectiveRailRelation<L, T> {
  /** station from the same arrangement solution as targetRect. */
  station: number;
}

const relationPart = (value: string): string => encodeURIComponent(value);

function noneRailRelation<L, T>(
  contentId: string,
  placement: RailPlacement["mode"],
): EffectiveRailRelation<L, T> {
  return {
    state: {
      boundTabId: null,
      boundPaneId: null,
      source: "none",
      relationId: `rail-relation/${relationPart(contentId)}/none`,
      placement,
      connected: false,
      side: "detached",
      borderMode: "none",
      pathCount: 0,
    },
    boundPane: null,
    boundTab: null,
    targetRect: null,
  };
}

/**
 * The single resolver for the effective rail relation.
 *
 * Uses the explicit binding when it is in a currently displayed cell, otherwise falls back to the active
 * tab of the focused pane in the screen's solution. The FLOW relation box is the rail-to-pane projection
 * the renderer actually draws; the PIN one is the actual pane rect. So renderer and state.tree/pane.list
 * have no reason to recompute adjacency and border branching separately.
 */
export function resolveEffectiveRailRelation<
  T extends { id: string },
  L extends { id: string; activeTabId: string; tabs: ReadonlyArray<T> },
>(input: {
  contentId: string;
  arrangement: Arrangement<L> | null | undefined;
  placement: RailPlacement["mode"];
  /** The actual value the renderer passes when the displayed station differs briefly from the solution's committed station, as during a drag. */
  station?: number;
}): EffectiveRailRelation<L, T> {
  const none = (): EffectiveRailRelation<L, T> =>
    noneRailRelation(input.contentId, input.placement);
  const arrangement = input.arrangement;
  // Presence is part of the solved arrangement. A raw `regionOpen` preference is not equivalent:
  // the selected plugin can have no linked set, in which case no rail, binding or adjacency exists.
  // Accepting a second boolean let state.tree publish union/1 while this same arrangement said the
  // rail was absent.
  if (!arrangement?.railPresent) return none();

  const panes = arrangement.displayLayout.cards.map((card) => card.data);
  const visibleIds = new Set(arrangement.cells.map((cell) => cell.id));
  // The focused pane, and nothing else. A space held a `railBindingTabId` that outranked the focus
  // until 2026-08-19 — carried over from the preceding implementation, which kept it equal to the
  // active view through a subscription. Only the reader came across, so the field was written by
  // nobody and restored from disk forever: measured on a running window, the active pane was
  // pan-ehc264 and the outline was drawn around pan-3557x4 on the other side of the rail. The field
  // is deleted rather than given a writer (L11c); a feature that binds a specific view brings one.
  const focusedPane = panes.find(
    (pane) => visibleIds.has(pane.id) && pane.id === arrangement.focusId,
  );
  const fallbackPane = panes.find((pane) => visibleIds.has(pane.id));
  const boundPane = focusedPane ?? fallbackPane;
  if (!boundPane) return none();
  const source: RailRelationSource = focusedPane ? "focus" : "fallback";

  const boundTab =
    boundPane.tabs.find((tab) => tab.id === boundPane.activeTabId) ?? boundPane.tabs[0];
  const cell = arrangement.cells.find((candidate) => candidate.id === boundPane.id);
  if (!boundTab || !cell) return none();

  const station = input.station ?? arrangement.station;
  const targetRect =
    input.placement === "pin"
      ? cell.rect
      : flowRailBoundBox(station, cell.rect);
  const side = classifyRailRelation(station, targetRect);
  const connected = side !== "detached";
  const borderMode: RailRelationBorderMode = connected ? "union" : "independent";
  const pathCount = connected ? 1 : 2;
  return {
    state: {
      boundTabId: boundTab.id,
      boundPaneId: boundPane.id,
      source,
      relationId: `rail-relation/${relationPart(input.contentId)}/${relationPart(boundPane.id)}/${relationPart(boundTab.id)}`,
      placement: input.placement,
      connected,
      side,
      borderMode,
      pathCount,
    },
    boundPane,
    boundTab,
    targetRect,
  };
}

/**
 * Relation marker resolution for a FLOW click commit.
 *
 * The active binding can point at the destination in the store first, while the displayed arrangement on
 * screen is still the departure solution. Mixing the two produces an intermediate outline stretched from
 * the departure station to the end of the destination pane. Consume a whole solution (station, cell,
 * relation) atomically only when the destination solution owns that binding as a real cell.
 */
export function resolvePresentedRailRelation<
  T extends { id: string },
  L extends { id: string; activeTabId: string; tabs: ReadonlyArray<T> },
>(input: {
  contentId: string;
  displayed: Arrangement<L> | null | undefined;
  destination: Arrangement<L> | null | undefined;
  placement: RailPlacement["mode"];
  station?: number;
}): PresentedRailRelation<L, T> {
  // FLOW presentation is owned by the destination focus: the displayed solve is still the departing
  // one while the panes travel, and reading the outline from it draws the relation the window is
  // leaving. PIN reads the displayed solve, because under PIN nothing travels.
  const destinationHasFocus = !!input.destination?.focusId
    && input.destination.cells.some((cell) => cell.id === input.destination?.focusId);
  const useDestination = input.placement === "flow" && destinationHasFocus;
  const station = useDestination
    ? input.destination?.station ?? 0
    : input.station ?? input.displayed?.station ?? 0;
  // The destination is the selected tab's solution and therefore owns whether a relation exists.
  // The displayed solution may still retain the departing strip for a closing frame; that visual
  // lifetime is not permission to bind it to a newly selected plugin with no linked set.
  const selectedRailPresent = input.destination?.railPresent
    ?? input.displayed?.railPresent
    ?? false;
  const resolved = selectedRailPresent
    ? resolveEffectiveRailRelation<T, L>({
        contentId: input.contentId,
        arrangement: useDestination ? input.destination : input.displayed,
        placement: input.placement,
        station,
      })
    : noneRailRelation<L, T>(input.contentId, input.placement);
  return {
    ...resolved,
    station,
  };
}

/** Whether the focused panel's left line is already a full-height clean line. A missing focus is no basis for disturbing the arrangement. */
function focusedLeftIsClean<L extends { id: string }>(
  tree: GridLayout<L>,
  focusId: string,
): boolean {
  const cells = cellsOf(tree);
  const target = cells.find((cell) => cell.value.id === focusId);
  if (!target) return true;
  return isCleanRailStation(
    cleanRailLines(cells.map((cell) => cell.rect)),
    target.rect.left,
  );
}

/**
 * Swap candidates — trees with the target swapped into the place of a **direct leaf sibling** in the same
 * row. Emitted nearest-left first. The move must always be minimal: the adopter stops at the first
 * candidate that becomes clean, so non-participating panels stay in place even for a distant focus.
 * sizes are swapped too — even for siblings of different widths each panel keeps its own width and only
 * exchanges position, so no content grows or shrinks.
 * A subtree is never moved wholesale and nested structure is never rewritten.
 */
function swapCandidates<L extends { id: string }>(
  node: GridLayout<L>,
  targetId: string,
): GridLayout<L>[] {
  const grid = new SplitPane(node, { width: 100, height: 100, gap: 0, minSize: 0 });
  const target = grid.rect(targetId);
  if (!target) return [];
  const candidates = [...grid.rects().entries()]
    .filter(([id]) => id !== targetId)
    .sort(([, a], [, b]) => Math.abs(a.x - target.x) - Math.abs(b.x - target.x));
  const out: GridLayout<L>[] = [];
  for (const [id, rect] of candidates) {
    const side = rect.x < target.x ? "left" : "right";
    const trial = new SplitPane(node, { width: 100, height: 100, gap: 0, minSize: 0 });
    if (trial.canMove(targetId, id, side) && trial.move(targetId, id, side)) {
      const state = trial.toJSON();
      out.push({ ...state, cards: state.cards.map((card) => ({ ...card, data: card.data as L })) });
    }
  }
  return out;
}

/** Switches a focus blocked by misaligned per-row vertical lines to the front. On failure the canonical tree is returned unchanged (identity preserved). */
function switchFocusedToFront<L extends { id: string }>(
  canonical: GridLayout<L>,
  focusId: string,
): GridLayout<L> {
  // Only rows the rail cannot reach in FLOW are resolved to the front. PIN never enters this function:
  // a click on a pinned sidebar is a focus change, not a layout operation, and it preserves the canonical tree.
  if (focusedLeftIsClean(canonical, focusId)) return canonical;
  for (const candidate of swapCandidates(canonical, focusId)) {
    if (focusedLeftIsClean(candidate, focusId)) return candidate;
  }
  return canonical;
}

/** FLOW: the focused panel's left line, or when blocked, the nearest clean line ahead of it (to the left). */
function flowStation(
  cells: ArrangementCell[],
  focusId: string | null,
  cleanLines: number[],
  fallback: number,
): number {
  const focused = cells.find((cell) => cell.id === focusId);
  // An unresolved focus is an absence of opinion — it does not mean "go to 0 (the front)", it means hold the
  // current position. On every intermediate render of a focus switch the lookup came back empty and
  // station collapsed to 0; that round trip opened a phantom global phase with no rail rect change and
  // pulsed every browser on screen (real incident).
  if (!focused) return snapRailStation(cleanLines, fallback);
  let station = 0;
  for (const line of cleanLines) {
    if (line <= focused.rect.left + RAIL_EPSILON) station = line;
    else break;
  }
  return station;
}

export function solveArrangement<L extends { id: string }>(input: {
  layout: GridLayout<L>;
  focusId: string | null | undefined;
  placement: RailPlacement;
  /** Whether the sidebar is open — when closed there is no rail to attach to. */
  railOpen: boolean;
  /** Maximized panel id — when present the layout is a single [rail | feature] plane, not the underlying split. */
  maximizedId?: string | null;
  /** Current position to hold when the focus is unresolved. */
  fallbackStation?: number;
  /**
   * Whether a focused pane in a row the rail cannot reach is resolved to the front, in FLOW.
   *
   * Ignored under PIN. A focus change on a pinned sidebar is not a layout operation, so neither pane nor
   * rail moves. Adjacent, a composed border expresses the relation; detached, two independent borders do.
   */
  pullFocused?: boolean;
}): Arrangement<L> {
  const focusId = input.focusId ?? null;

  if (input.maximizedId) {
    const cells = [{ id: input.maximizedId, rect: FULL_RECT }];
    const cleanLines = cleanRailLines([FULL_RECT]);
    let maximizedStation = 0;
    if (input.placement.mode === "pin") {
      const canonicalCells = cellsOf(input.layout).map(({ value, rect }) => ({
        id: value.id,
        rect,
      }));
      const canonicalLines = cleanRailLines(canonicalCells.map((cell) => cell.rect));
      const pinnedStation = snapRailStation(canonicalLines, input.placement.station);
      const original = canonicalCells.find((cell) => cell.id === input.maximizedId);
      // Maximization is a temporary projection that does not use the PIN setting. If the active pane is
      // left of the original rail, pane left and sidebar right; if right, sidebar left and pane right —
      // only the relation is preserved.
      maximizedStation = original && original.rect.left < pinnedStation - RAIL_EPSILON ? 100 : 0;
    }
    return {
      railPresent: input.railOpen,
      station: maximizedStation,
      cleanLines,
      displayLayout: input.layout,
      swapped: false,
      // Maximization is a single [rail | feature] plane, so there is no slot to be wedged between.
      betweenIds: [],
      cells,
      focusId,
      maximizedId: input.maximizedId,
    };
  }

  // No rendered sidebar means there is no rail position, adjacency or blocked corridor to solve.
  // Keep the canonical pane order and one stable station so focus-only changes cannot open a
  // geometry transaction for an element that does not exist.
  if (!input.railOpen) {
    const cells = cellsOf(input.layout).map(({ value, rect }) => ({ id: value.id, rect }));
    return {
      railPresent: false,
      station: 0,
      cleanLines: cleanRailLines(cells.map((cell) => cell.rect)),
      displayLayout: input.layout,
      swapped: false,
      betweenIds: [],
      cells,
      focusId,
      maximizedId: null,
    };
  }

  // PIN is an anchoring contract: neither focus nor setting changes the rail or the canonical layout.
  // Only FLOW follows the focus, and it swaps panes only when resolving an unreachable row is requested
  // explicitly.
  const pull = input.pullFocused ?? true;
  const displayLayout =
    input.placement.mode === "flow" && pull && input.railOpen && focusId
      ? switchFocusedToFront(input.layout, focusId)
      : input.layout;

  const cells = cellsOf(displayLayout).map(({ value, rect }) => ({
    id: value.id,
    rect,
  }));
  const cleanLines = cleanRailLines(cells.map((cell) => cell.rect));
  const station =
    input.placement.mode === "pin"
      ? snapRailStation(cleanLines, input.placement.station)
      : flowStation(cells, focusId, cleanLines, input.fallbackStation ?? 0);

  return {
    railPresent: true,
    station:
      station,
    cleanLines,
    betweenIds: betweenRailAndFocus(cells, focusId, station),
    displayLayout,
    swapped: displayLayout !== input.layout,
    cells,
    focusId,
    // This solution renders no maximization — if a consumer judges maximization from raw state, that
    // judgment disagrees with this solution's station.
    maximizedId: null,
  };
}

/**
 * The move delta between two arrangements. Emits the visual offset at phase start (old position − new
 * position) as a logical delta: arrangement swap in container %, insertion point change in multiples of
 * rail width. The two axes have different units and cannot be folded into one number — composition
 * happens once, in the consumer that has the measured width, through moveOffsetPx. Interpolating the two
 * axes in different places makes them disagree in a phase where both change at once (switching + travel).
 *
 * The list holds only panels that actually move — putting animation and layer promotion on a zero-delta
 * element makes unrelated surfaces pay re-raster cost every phase (real incident).
 */
export function arrangementMoves<L>(
  from: Pick<Arrangement<L>, "station" | "cells">,
  to: Pick<Arrangement<L>, "station" | "cells">,
): ArrangementMove[] {
  const moves: ArrangementMove[] = [];
  for (const cell of to.cells) {
    const before = from.cells.find((item) => item.id === cell.id);
    if (!before) continue; // A newly created panel is an appearance, not a move
    const dLeftPct = before.rect.left - cell.rect.left;
    const dRailUnits =
      projectRailCssRect(before.rect, from.station).railLeft -
      projectRailCssRect(cell.rect, to.station).railLeft;
    if (
      Math.abs(dLeftPct) < MOVE_EPSILON_PCT &&
      Math.abs(dRailUnits) < MOVE_EPSILON_RAIL
    ) {
      continue;
    }
    moves.push({ id: cell.id, dLeftPct, dRailUnits });
  }
  return moves;
}

/** Whether two solved projections differ in visible geometry, including snap-only membership/size changes. */
export function projectionGeometryChanged<L>(
  from: Pick<Arrangement<L>, "railPresent" | "station" | "cells">,
  to: Pick<Arrangement<L>, "railPresent" | "station" | "cells">,
): boolean {
  if (from.railPresent !== to.railPresent
    || !Object.is(from.station, to.station)
    || from.cells.length !== to.cells.length) return true;
  return from.cells.some((cell, index) => {
    const next = to.cells[index];
    return !next
      || cell.id !== next.id
      || !Object.is(cell.rect.left, next.rect.left)
      || !Object.is(cell.rect.top, next.rect.top)
      || !Object.is(cell.rect.width, next.rect.width)
      || !Object.is(cell.rect.height, next.rect.height);
  });
}

/** Logical move delta → physical offset (px). The container width is a measured value, so the consumer owns the composition. */
export function moveOffsetPx(
  move: ArrangementMove,
  hostWidthPx: number,
  railWidthPx: number,
): number {
  return (hostWidthPx * move.dLeftPct) / 100 + railWidthPx * move.dRailUnits;
}

/**
 * Move delta of a decoration span (divider, drop indicator). A span is part of the corridor, not a panel
 * — it does not take part in the arrangement swap, so the only source of movement is the insertion point
 * change, and a span that runs through the rail is mapped including the physical gap (distinct from the
 * panel rule).
 *
 * When this value is 0 the cells travel while the span alone teleports to the destination at t0, and the
 * screen is torn for the whole phase — the failure mode of corridor sync (§12-③). So it uses the same
 * type and the same composition function as the panel move delta.
 */
export function spanMoveAcross(
  rect: Rect,
  fromStation: number,
  toStation: number,
): ArrangementMove {
  return {
    id: "",
    dLeftPct: 0,
    dRailUnits:
      projectRailCssSpan(rect, fromStation).railLeft -
      projectRailCssSpan(rect, toStation).railLeft,
  };
}

/**
 * View ids of the panels the move deltas point at. Freeze, veil, and travel premises all go to this set
 * only — a surface that does not move stays live for the whole phase and receives no notification at all.
 * Judgment and render must use the same rule so that "the premise said it could be covered, yet another
 * surface moves" does not arise.
 */
export function viewIdsOfMoves<
  L extends { id: string; tabs: ReadonlyArray<{ id: string }> },
>(layout: GridLayout<L>, moves: readonly ArrangementMove[]): string[] {
  if (moves.length === 0) return [];
  const groups = layout.cards.map((card) => card.data);
  return moves.flatMap(
    (move) => groups.find((g) => g.id === move.id)?.tabs.map((v) => v.id) ?? [],
  );
}

/**
 * Panes wedged between the rail (station) and the focused pane — in the same row, after the rail and
 * before the focus.
 *
 * Empty when the rail reached the focused pane. That emptiness is the fact "nothing is hidden".
 */
function betweenRailAndFocus(
  cells: ArrangementCell[],
  focusId: string | null,
  station: number,
): string[] {
  if (!focusId) return [];
  const focused = cells.find((cell) => cell.id === focusId);
  if (!focused) return [];
  return cells
    .filter(
      (cell) =>
        cell.id !== focusId &&
        // In the same row (vertically overlapping), after the rail, and before the focused pane.
        cell.rect.top < focused.rect.top + focused.rect.height &&
        cell.rect.top + cell.rect.height > focused.rect.top &&
        cell.rect.left + RAIL_EPSILON >= station &&
        cell.rect.left + cell.rect.width <= focused.rect.left + RAIL_EPSILON,
    )
    .map((cell) => cell.id);
}
