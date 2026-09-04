// Arrangement solver — what the screen draws for a space is a pure function of (plane, focus).
//
// The plane is the library's (state/panePlane): the rail stands on it as a card, and every number
// here is read from the plane. What the solver adds is the presentation that follows focus: the
// focused pane pulled beside the rail in FLOW when the setting is on, and a maximized pane shown
// alone. Every consumer reads one solution — station, cells, dividers, adjacency — because two
// computations of the same thing agree until they do not, and the second one is drawn.

import {
  RAIL_CARD, paneIds, pullToFront, dividersOf, railStandings, rectsOf, soloPlane, standingsPx,
  withdrawRail, type Divider, type PlaneBox, type PlaneState,
} from "../state/panePlane";
import type { RailPlacement } from "./railPlacement";

/** A rect on the plane, in px from the plane's origin. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ArrangementCell {
  id: string;
  rect: Rect;
}

export interface Arrangement {
  /** Whether the rail stands on the plane drawn. */
  railPresent: boolean;
  /** The rail's left edge in px. 0 when it does not stand. */
  station: number;
  /** The px position of every line the rail could stand on. */
  cleanLines: number[];
  /** The index of each of those lines on the plane drawn, in the same order. */
  standingLines: number[];
  /**
   * The line set of the panes: how many lines on each axis and which slots each pane spans, with
   * the rail's own slot left out. A split or merge changes it; a resize or the rail's travel does
   * not, so it names the plane a travel can run on.
   */
  lineSet: string;
  /** The plane drawn. The space's own plane unless focus or maximize changed the presentation. */
  display: PlaneState;
  /** Whether the focused pane was exchanged with a neighbour to stand beside the rail (FLOW). */
  swapped: boolean;
  /** Every pane on the plane drawn, in reading order. */
  cells: ArrangementCell[];
  /** The rail's rect, when it stands. */
  rail: Rect | null;
  /** The corridor between two cards on this plane, in px. */
  gap: number;
  /** Where each boundary can be grabbed. None while maximized. */
  dividers: Divider[];
  focusId: string | null;
  /**
   * Panes wedged between the rail and the focused pane — non-empty only when the rail could not
   * stand beside that pane. A pure geometric fact; consumers choose the presentation.
   */
  betweenIds: string[];
  /**
   * The pane this solution shows alone, or null. A consumer never re-reads maximize from raw state:
   * station and rects are decided together here, and a flag from another moment puts a new rect on
   * an old line.
   */
  maximizedId: string | null;
}

export interface ArrangementMove {
  id: string;
  /** How far the pane's left edge moved, in px, as the offset it starts the travel at. */
  dLeft: number;
}

const toRect = (r: { x: number; y: number; w: number; h: number }): Rect =>
  ({ left: r.x, top: r.y, width: r.w, height: r.h });

export function presentedRailWidth(
  arrangement: Pick<Arrangement, "railPresent" | "rail"> | null | undefined,
): number {
  return arrangement?.railPresent ? (arrangement.rail?.width ?? 0) : 0;
}

export type RailRelationBorderMode = "union" | "independent" | "none";
export type RailRelationSide = "left" | "right" | "detached";

/** Why this pane is the one the rail is grouped with. `focus` is the rule; `fallback` is a space
 *  whose focused pane is not on the screen's solution, which is a state and not a choice. */
export type RailRelationSource = "focus" | "fallback" | "none";

export interface RailRelationState {
  boundTabId: string | null;
  boundPaneId: string | null;
  source: RailRelationSource;
  relationId: string;
  placement: RailPlacement["mode"];
  connected: boolean;
  side: RailRelationSide;
  borderMode: RailRelationBorderMode;
  pathCount: 0 | 1 | 2;
}

export interface EffectiveRailRelation<L, T> {
  state: RailRelationState;
  boundPane: L | null;
  boundTab: T | null;
  /** The rail and the bound pane as one box under FLOW; the pane's own rect under PIN. */
  targetRect: Rect | null;
  /** The bound pane's own rect. */
  paneRect: Rect | null;
}

export interface PresentedRailRelation<L, T> extends EffectiveRailRelation<L, T> {
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
    paneRect: null,
  };
}

/** Which edge of the rail a pane touches across the corridor, if either. */
export function classifyRailRelation(rail: Rect, target: Rect, gap: number): RailRelationSide {
  const tolerance = gap + 1;
  if (Math.abs(target.left + target.width - rail.left) <= tolerance) return "left";
  if (Math.abs(target.left - (rail.left + rail.width)) <= tolerance) return "right";
  return "detached";
}

/** The rail and the pane beside it as one box. */
export function railBoundBox(rail: Rect, target: Rect): Rect {
  const left = Math.min(rail.left, target.left);
  const right = Math.max(rail.left + rail.width, target.left + target.width);
  return { left, top: target.top, width: right - left, height: target.height };
}

/**
 * The single resolver for the effective rail relation: the focused pane when it is on the plane
 * drawn, otherwise the first pane there.
 */
export function resolveEffectiveRailRelation<
  T extends { id: string },
  L extends { id: string; activeTabId: string; tabs: ReadonlyArray<T> },
>(input: {
  contentId: string;
  arrangement: Arrangement | null | undefined;
  panes: readonly L[];
  placement: RailPlacement["mode"];
  gap: number;
}): EffectiveRailRelation<L, T> {
  const none = (): EffectiveRailRelation<L, T> =>
    noneRailRelation(input.contentId, input.placement);
  const arrangement = input.arrangement;
  if (!arrangement?.railPresent || !arrangement.rail) return none();

  const order = arrangement.cells.map((cell) => cell.id);
  const focusedPane = input.panes.find(
    (pane) => order.includes(pane.id) && pane.id === arrangement.focusId,
  );
  const fallbackPane = order.map((id) => input.panes.find((pane) => pane.id === id))
    .find((pane): pane is L => pane !== undefined);
  const boundPane = focusedPane ?? fallbackPane;
  if (!boundPane) return none();
  const source: RailRelationSource = focusedPane ? "focus" : "fallback";

  const boundTab =
    boundPane.tabs.find((tab) => tab.id === boundPane.activeTabId) ?? boundPane.tabs[0];
  const cell = arrangement.cells.find((candidate) => candidate.id === boundPane.id);
  if (!boundTab || !cell) return none();

  const side = classifyRailRelation(arrangement.rail, cell.rect, input.gap);
  const connected = side !== "detached";
  const targetRect = input.placement === "pin" || !connected
    ? cell.rect
    : railBoundBox(arrangement.rail, cell.rect);
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
    paneRect: cell.rect,
  };
}

/**
 * The relation for a FLOW click: read from the destination solution, which owns the focus, while
 * the displayed one is still the departure. PIN reads the displayed solution; nothing travels.
 */
export function resolvePresentedRailRelation<
  T extends { id: string },
  L extends { id: string; activeTabId: string; tabs: ReadonlyArray<T> },
>(input: {
  contentId: string;
  displayed: Arrangement | null | undefined;
  destination: Arrangement | null | undefined;
  panes: readonly L[];
  placement: RailPlacement["mode"];
  gap: number;
}): PresentedRailRelation<L, T> {
  const destinationHasFocus = !!input.destination?.focusId
    && input.destination.cells.some((cell) => cell.id === input.destination?.focusId);
  const useDestination = input.placement === "flow" && destinationHasFocus;
  const arrangement = useDestination ? input.destination : input.displayed;
  const selectedRailPresent = input.destination?.railPresent
    ?? input.displayed?.railPresent
    ?? false;
  const resolved = selectedRailPresent
    ? resolveEffectiveRailRelation<T, L>({
        contentId: input.contentId,
        arrangement,
        panes: input.panes,
        placement: input.placement,
        gap: input.gap,
      })
    : noneRailRelation<L, T>(input.contentId, input.placement);
  return { ...resolved, station: arrangement?.station ?? 0 };
}

/** Panes in the focused pane's rows, after the rail and before the pane. */
function betweenRailAndFocus(
  cells: ArrangementCell[],
  rail: Rect | null,
  focusId: string | null,
): string[] {
  if (!focusId || !rail) return [];
  const focused = cells.find((cell) => cell.id === focusId);
  if (!focused) return [];
  const railRight = rail.left + rail.width;
  return cells
    .filter((cell) =>
      cell.id !== focusId
      && cell.rect.top < focused.rect.top + focused.rect.height
      && cell.rect.top + cell.rect.height > focused.rect.top
      && cell.rect.left >= railRight
      && cell.rect.left + cell.rect.width <= focused.rect.left)
    .map((cell) => cell.id);
}

export function solveArrangement(input: {
  layout: PlaneState;
  box: PlaneBox;
  focusId: string | null | undefined;
  placement: RailPlacement;
  /** Whether a set stands in the rail. Without one the rail card is not drawn. */
  railPresent: boolean;
  /** The pane shown alone, when one is. */
  maximizedId?: string | null;
  /** FLOW: whether a focused pane the rail cannot reach is exchanged to the front of its row. */
  pullFocused?: boolean;
}): Arrangement {
  const focusId = input.focusId ?? null;
  const shown = input.railPresent ? input.layout : withdrawRail(input.layout, input.box);

  if (input.maximizedId) {
    const display = soloPlane(shown, input.maximizedId);
    return read(display, input.box, focusId, {
      swapped: false, maximizedId: input.maximizedId, dividers: false,
    });
  }

  const pulled = input.placement.mode === "flow" && input.railPresent && (input.pullFocused ?? true) && focusId
    ? pullToFront(shown, input.box, focusId)
    : shown;
  return read(pulled, input.box, focusId, {
    swapped: pulled !== shown, maximizedId: null, dividers: true,
  });
}

function read(
  display: PlaneState,
  box: PlaneBox,
  focusId: string | null,
  facts: { swapped: boolean; maximizedId: string | null; dividers: boolean },
): Arrangement {
  const rects = rectsOf(display, box);
  const cells = paneIds(display).map((id) => ({ id, rect: toRect(rects.get(id)!) }));
  const railRect = rects.get(RAIL_CARD);
  const rail = railRect ? toRect(railRect) : null;
  return {
    railPresent: rail !== null,
    station: rail?.left ?? 0,
    cleanLines: standingsPx(display, box),
    standingLines: railStandings(display, box),
    lineSet: lineSetOf(display),
    display,
    swapped: facts.swapped,
    cells,
    rail,
    gap: box.gap,
    dividers: facts.dividers ? dividersOf(display, box) : [],
    focusId,
    betweenIds: betweenRailAndFocus(cells, rail, focusId),
    maximizedId: facts.maximizedId,
  };
}

/** The panes' spans with the rail's slot taken out, so the rail's travel does not change it. */
function lineSetOf(display: PlaneState): string {
  const rail = display.cards.find((c) => c.id === RAIL_CARD);
  const drop = (c: number) => (rail && c > rail.c0 ? c - 1 : c);
  const columns = display.xs.length - 1 - (rail ? 1 : 0);
  const rows = display.ys.length - 1;
  const spans = display.cards
    .filter((c) => c.id !== RAIL_CARD)
    .map((c) => `${c.id}@${drop(c.c0)}-${drop(c.c1)},${c.r0}-${c.r1}`)
    .sort();
  return `${columns}x${rows}:${spans.join(";")}`;
}

const MOVE_EPSILON_PX = 0.5;

/**
 * The panes that travel between two arrangements — the same box at another left — with the
 * offset each starts its travel at. A pane whose box changed shape is not one of them: a travel
 * is a translate, and translating a pane whose width also changed moves an edge that stays. Only
 * those: putting animation and layer promotion on a pane that does not move makes unrelated
 * surfaces pay re-raster cost every phase (measured).
 *
 * A width that changed by no more than half the corridor is the same box: a rail landing on or
 * leaving the plane's border charges its neighbours half a gap (split-pane R5), and measured
 * 2026-09-05, that 2.7px made every rail travel a snap instead of a journey.
 */
export function arrangementMoves(
  from: Pick<Arrangement, "cells">,
  to: Pick<Arrangement, "cells"> & Partial<Pick<Arrangement, "gap">>,
): ArrangementMove[] {
  const moves: ArrangementMove[] = [];
  const widthTolerance = (to.gap ?? 0) / 2 + MOVE_EPSILON_PX;
  for (const cell of to.cells) {
    const before = from.cells.find((item) => item.id === cell.id);
    if (!before) continue; // A pane that appears is not one that moves.
    const dLeft = before.rect.left - cell.rect.left;
    const same = (a: number, b: number, tolerance = MOVE_EPSILON_PX) => Math.abs(a - b) < tolerance;
    // A shift of no more than the half gap is the border's charge on a neighbour, not a travel.
    if (same(dLeft, 0, widthTolerance)) continue;
    if (!same(before.rect.width, cell.rect.width, widthTolerance) || !same(before.rect.top, cell.rect.top)
      || !same(before.rect.height, cell.rect.height)) continue;
    moves.push({ id: cell.id, dLeft });
  }
  return moves;
}

/** Whether two solutions differ in what is drawn. */
export function projectionGeometryChanged(
  from: Pick<Arrangement, "railPresent" | "station" | "cells">,
  to: Pick<Arrangement, "railPresent" | "station" | "cells">,
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

/**
 * View ids of the panes the moves point at. Freeze, veil and travel premises all go to this set
 * only — a surface that does not move stays live for the whole phase.
 */
export function viewIdsOfMoves<
  L extends { id: string; tabs: ReadonlyArray<{ id: string }> },
>(panes: readonly L[], moves: readonly ArrangementMove[]): string[] {
  if (moves.length === 0) return [];
  return moves.flatMap(
    (move) => panes.find((g) => g.id === move.id)?.tabs.map((v) => v.id) ?? [],
  );
}
