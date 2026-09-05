// The pane plane of a space — the one file that reads or writes split-pane state.
//
// A space holds its panes on one plane of shared grid lines (split-pane R1). The plane is the
// library's: the core names a pane, a side or a boundary and reads back the state the library
// produced. No rect, divider or drop zone is computed here or anywhere else in the core; the host
// component and a command both read them from the functions below, in the plane size the host
// measured (`planeBox`).
//
// The rail is a card on this plane (split-pane R2): a fixed card of a declared width spanning
// every row. It stands on the plane while a set stands in it, and it is stored with the
// plane; when it withdraws, the library's R5 gives the width back to the slot it took it from, so
// the panes keep their proportions.
//
// Every operation is a pure function: state in, state out, `null` when the library refused.

import {
  SplitPane, checkState,
  type Divider, type Rect, type Side, type SplitPaneState, type ZoneHit,
} from "split-pane";
import { CHROME_BANDS } from "../lib/chromeBands";

export type PlaneState = SplitPaneState;
export type { Divider, Rect, Side, ZoneHit };

export const RAIL_CARD = "rail";

/** Which edge of a pane a boundary is named by. */
export type Edge = "left" | "right" | "top" | "bottom";

/** The plane in px, and the corridor and floor a theme declares. */
export interface PlaneBox {
  width: number;
  height: number;
  /** Corridor between two panes: twice the pane inset (UI-GEOMETRY R1b). */
  gap: number;
}

/** A pane keeps its two chrome bands and two more bands of body (MIN_PANE_BODY_PX). */
export const MIN_PANE_PX = CHROME_BANDS.header * 3 + CHROME_BANDS.footer;

const grid = (state: PlaneState, box: PlaneBox): SplitPane =>
  SplitPane.from(state, {
    width: box.width,
    height: box.height,
    gap: box.gap,
    minSize: MIN_PANE_PX,
    snap: "off",
  });

/** A plane holding one pane. */
export const singlePane = (paneId: string): PlaneState => ({
  xs: [0, 1],
  ys: [0, 1],
  cards: [{ id: paneId, c0: 0, c1: 1, r0: 0, r1: 1 }],
});

/** Whether a stored value describes a plane. Throws the library's reason when it does not. */
export const checkPlane = (state: PlaneState): void => checkState(state);

/** Pane ids in reading order: top to bottom, then left to right. The rail is not a pane. */
export function paneIds(state: PlaneState): string[] {
  return state.cards
    .filter((card) => card.id !== RAIL_CARD)
    .sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0 || (a.id < b.id ? -1 : 1))
    .map((card) => card.id);
}

export const hasPane = (state: PlaneState, paneId: string): boolean =>
  paneId !== RAIL_CARD && state.cards.some((card) => card.id === paneId);

export const hasRail = (state: PlaneState): boolean =>
  state.cards.some((card) => card.id === RAIL_CARD);

/** The plane a split of `targetId` toward `side` produces; the new pane takes `freshId`. */
export function splitPane(
  state: PlaneState, box: PlaneBox, targetId: string, side: Side, freshId: string,
): PlaneState | null {
  if (!hasPane(state, targetId) || hasPane(state, freshId)) return null;
  const plane = grid(state, box);
  return plane.splitToward(targetId, side, { id: freshId }) === null ? null : plane.toJSON();
}

/**
 * The plane without `paneId`; its neighbours grow over the room (split-pane R7). A line the
 * departure left with no card on it is dropped (`tidy`): kept, every later insert lands beside it
 * and the plane's lines grow with each rail that withdraws (measured 2026-09-05: four lines for
 * two columns after one withdraw, five with a coincident pair after the next stand).
 */
export function closePane(state: PlaneState, box: PlaneBox, paneId: string): PlaneState | null {
  if (!hasPane(state, paneId)) return null;
  const plane = grid(state, box);
  if (!plane.close(paneId)) return null;
  plane.tidy();
  return plane.toJSON();
}

/** The plane with `paneId` moved to `side` of `targetId` — one operation, not a close and a split. */
export function movePane(
  state: PlaneState, box: PlaneBox, paneId: string, targetId: string, side: Side,
): PlaneState | null {
  if (!hasPane(state, paneId) || !hasPane(state, targetId) || paneId === targetId) return null;
  const plane = grid(state, box);
  return plane.move(paneId, targetId, side) ? plane.toJSON() : null;
}

/** The boundary a pane's edge stands on. */
export function boundaryOf(
  state: PlaneState, paneId: string, edge: Edge,
): { axis: "x" | "y"; line: number } | null {
  const card = state.cards.find((c) => c.id === paneId);
  if (!card || paneId === RAIL_CARD) return null;
  const axis = edge === "left" || edge === "right" ? "x" : "y";
  const line = edge === "left" ? card.c0 : edge === "right" ? card.c1 : edge === "top" ? card.r0 : card.r1;
  const last = (axis === "x" ? state.xs : state.ys).length - 1;
  return line <= 0 || line >= last ? null : { axis, line };
}

/**
 * The two slots meeting at a boundary, as shares of their sum — measured in px, where the
 * boundaries stand. A slot's share of the lines is not its px beside a card with a declared width
 * (the rail): measured 2026-09-05, a drag of 80px beside the rail landed 26.5px over, because the
 * ratio the drag committed was read from the lines and applied in px.
 */
export function boundaryShares(
  state: PlaneState, box: PlaneBox, axis: "x" | "y", line: number,
): [number, number] {
  const plane = grid(state, box);
  const before = plane.boundaryPos(axis, line) - plane.boundaryPos(axis, line - 1);
  const after = plane.boundaryPos(axis, line + 1) - plane.boundaryPos(axis, line);
  const sum = before + after;
  return sum > 0 ? [before / sum, after / sum] : [0.5, 0.5];
}

/**
 * The plane with one boundary moved so that the slot before it holds `ratio` of the two slots
 * that meet there. The library keeps every pane at or above its floor; the answer is what it
 * allowed.
 */
export function moveBoundary(
  state: PlaneState, box: PlaneBox, axis: "x" | "y", line: number, ratio: number,
): PlaneState | null {
  const plane = grid(state, box);
  if (!plane.hasBoundary(axis, line)) return null;
  const lo = plane.boundaryPos(axis, line - 1);
  const hi = plane.boundaryPos(axis, line + 1);
  plane.moveBoundary(axis, line, lo + (hi - lo) * ratio, false);
  return plane.toJSON();
}

/** The plane with one boundary centred between its two neighbours. */
export function centerBoundary(
  state: PlaneState, box: PlaneBox, axis: "x" | "y", line: number,
): PlaneState | null {
  const plane = grid(state, box);
  if (!plane.hasBoundary(axis, line)) return null;
  plane.centerBoundary(axis, line);
  return plane.toJSON();
}

/**
 * The plane with every sharing slot on an axis drawn at one width. A slot with a declared px size
 * (the rail) keeps it. A slot pays half a gap for each neighbour it has (split-pane R5), so equal
 * rects are not equally spaced lines.
 */
export function equalizeAxis(state: PlaneState, box: PlaneBox, axis: "x" | "y"): PlaneState {
  const plane = grid(state, box);
  const count = (axis === "x" ? state.xs : state.ys).length - 1;
  const span = plane.boundaryPos(axis, count);
  const charge = (slot: number) =>
    (slot > 0 ? box.gap / 2 : 0) + (slot < count - 1 ? box.gap / 2 : 0);
  const fixedSpans = new Map<number, number>();
  for (const card of plane.cards) {
    const [lo, hi] = axis === "x" ? [card.c0, card.c1] : [card.r0, card.r1];
    const size = axis === "x" ? card.width : card.height;
    if (hi - lo === 1 && typeof size === "number") fixedSpans.set(lo, size + charge(lo));
  }
  let room = span;
  let sharing = 0;
  for (let slot = 0; slot < count; slot++) {
    const fixed = fixedSpans.get(slot);
    if (fixed !== undefined) room -= fixed;
    else { room -= charge(slot); sharing++; }
  }
  const width = sharing > 0 ? room / sharing : 0;
  let at = 0;
  for (let slot = 0; slot < count - 1; slot++) {
    at += fixedSpans.get(slot) ?? width + charge(slot);
    plane.moveBoundary(axis, slot + 1, at, false);
  }
  return plane.toJSON();
}

/** Lines a rail could stand on: every vertical line no pane spans across (split-pane R3). */
export function railStandings(state: PlaneState, box: PlaneBox): number[] {
  return grid(state, box).standings("x", RAIL_CARD);
}

/**
 * The plane with the rail standing on `line` at `widthPx`, fixed. A rail already on the plane is
 * moved. The width is in the plane because the library keeps the slot's share by it (R5): a slot
 * opened at one width and drawn at another gives the wrong room back when it closes (measured in
 * panePlane.test.ts: 38.6px lost on a withdraw). The place's width setting is the input; the host
 * writes it here through one action, and the two are compared by a test.
 */
export function standRail(
  state: PlaneState, box: PlaneBox, line: number, widthPx: number,
): PlaneState | null {
  const plane = grid(state, box);
  const rail = plane.card(RAIL_CARD);
  if (rail) {
    if (rail.c0 !== line && !plane.moveTo(RAIL_CARD, "x", line)) return null;
    plane.setSize(RAIL_CARD, "x", widthPx);
    return plane.toJSON();
  }
  if (plane.insertAt("x", line, { id: RAIL_CARD, size: widthPx }) === null) return null;
  plane.setFixed(RAIL_CARD, true);
  return plane.toJSON();
}

/** The plane with the rail at another width. Unchanged when no rail stands. */
export function resizeRail(state: PlaneState, box: PlaneBox, widthPx: number): PlaneState {
  if (!hasRail(state)) return state;
  const plane = grid(state, box);
  plane.setSize(RAIL_CARD, "x", widthPx);
  return plane.toJSON();
}

/** The width the rail is drawn at, or null when none stands. */
export function railWidth(state: PlaneState): number | null {
  return state.cards.find((c) => c.id === RAIL_CARD)?.width ?? null;
}

/** The plane without the rail. The room goes back to the slot beside it (split-pane R5). */
export function withdrawRail(state: PlaneState, box: PlaneBox): PlaneState {
  if (!hasRail(state)) return state;
  const plane = grid(state, box);
  plane.setFixed(RAIL_CARD, false);
  plane.close(RAIL_CARD);
  plane.tidy();
  return plane.toJSON();
}

/**
 * The line the rail stands on for a focused pane in FLOW: the nearest standing at or before the
 * pane's left edge, measured on the plane without the rail so the answer does not move with the
 * rail itself; the first standing when none is before it. A rail standing beside the pane already
 * answers its own line.
 */
export function flowRailLine(state: PlaneState, box: PlaneBox, paneId: string): number | null {
  const plane = grid(state, box);
  const standings = plane.standings("x", RAIL_CARD);
  if (standings.length === 0) return null;
  const want = plane.rect(paneId)?.x;
  if (want === undefined) return null;
  const before = standings.filter((line) => plane.boundaryPos("x", line) <= want + 0.5);
  return before.length > 0 ? before[before.length - 1] : standings[0];
}

/** The line the rail stands on, or null. */
export function railLine(state: PlaneState): number | null {
  return state.cards.find((c) => c.id === RAIL_CARD)?.c0 ?? null;
}

/**
 * A plane showing one pane over the whole space, with the rail beside it on the side it stood on
 * — a pane left of the rail keeps the rail on its right, so only the relation is preserved. This
 * is a presentation of the space, not a change to its layout.
 */
export function soloPlane(state: PlaneState, paneId: string): PlaneState {
  const rail = state.cards.find((c) => c.id === RAIL_CARD);
  const pane = state.cards.find((c) => c.id === paneId);
  if (!rail || !pane) return singlePane(paneId);
  const railCard = { id: RAIL_CARD, r0: 0, r1: 1, width: rail.width, fixed: true };
  const paneLeftOfRail = pane.c1 <= rail.c0;
  // The pane's slot is the sharing one and takes the whole line; the rail's slot is drawn at its
  // declared width.
  return {
    xs: paneLeftOfRail ? [0, 1, 1] : [0, 0, 1],
    ys: [0, 1],
    cards: paneLeftOfRail
      ? [{ id: paneId, c0: 0, c1: 1, r0: 0, r1: 1 }, { ...railCard, c0: 1, c1: 2 }]
      : [{ ...railCard, c0: 0, c1: 1 }, { id: paneId, c0: 1, c1: 2, r0: 0, r1: 1 }],
  };
}

/**
 * The plane with the focused pane exchanged with a pane at its left in the same row, so the rail
 * can stand at its left. Unchanged when the pane's left line already stands. The nearest exchange
 * that frees the line is taken, each pane keeps its own width, and the lines between the two are
 * re-dealt in the new order — a card in another row that references one of them follows it
 * (split-pane R1). A presentation, never stored.
 */
export function pullToFront(state: PlaneState, box: PlaneBox, paneId: string): PlaneState {
  const focused = state.cards.find((c) => c.id === paneId);
  if (!focused || paneId === RAIL_CARD) return state;
  if (grid(state, box).standings("x", RAIL_CARD).includes(focused.c0)) return state;
  const partners = state.cards
    .filter((c) => c.id !== paneId && c.id !== RAIL_CARD
      && c.r0 === focused.r0 && c.r1 === focused.r1 && c.c1 <= focused.c0)
    .sort((a, b) => b.c1 - a.c1);
  for (const partner of partners) {
    const candidate = exchanged(state, partner, focused);
    if (grid(candidate, box).standings("x", RAIL_CARD).includes(partner.c0)) return candidate;
  }
  return state;
}

type CardSpan = PlaneState["cards"][number];

/** The plane with `left` and `right` (same row, left before right) in each other's place. */
function exchanged(state: PlaneState, left: CardSpan, right: CardSpan): PlaneState {
  const leftSpan = left.c1 - left.c0;
  const rightSpan = right.c1 - right.c0;
  const segments = state.xs.slice(1).map((x, i) => x - state.xs[i]);
  const dealt = [
    ...segments.slice(right.c0, right.c1),
    ...segments.slice(left.c1, right.c0),
    ...segments.slice(left.c0, left.c1),
  ];
  const xs = [...state.xs];
  let at = state.xs[left.c0];
  dealt.forEach((width, i) => {
    at += width;
    xs[left.c0 + i + 1] = at;
  });
  const between = (c: CardSpan) => c.c0 >= left.c1 && c.c1 <= right.c0;
  const cards = state.cards.map((c) => {
    if (c.id === right.id) return { ...c, c0: left.c0, c1: left.c0 + rightSpan };
    if (c.id === left.id) return { ...c, c0: right.c1 - leftSpan, c1: right.c1 };
    if (between(c)) return { ...c, c0: c.c0 + rightSpan - leftSpan, c1: c.c1 + rightSpan - leftSpan };
    return c;
  });
  const next = { ...state, xs, cards };
  checkState(next);
  return next;
}

/** Every card's rect on the plane, in px. */
export function rectsOf(state: PlaneState, box: PlaneBox): Map<string, Rect> {
  return grid(state, box).rects();
}

/** Where each boundary can be grabbed, in px. */
export function dividersOf(state: PlaneState, box: PlaneBox): Divider[] {
  return grid(state, box).dividers();
}

/** The px position of each line a rail could stand on. */
export function standingsPx(state: PlaneState, box: PlaneBox): number[] {
  const plane = grid(state, box);
  return plane.standings("x", RAIL_CARD).map((line) => plane.boundaryPos("x", line));
}

/** Where a point on the plane lands: which pane, and which of its sides or its centre. */
export function zoneAt(
  state: PlaneState, box: PlaneBox, x: number, y: number,
  options: { headerPx: number; footerPx: number; centreOnly?: string },
): ZoneHit | null {
  const hit = grid(state, box).zoneAt(x, y, options);
  return hit && hit.id !== RAIL_CARD ? hit : null;
}

/** The plane with one boundary at `px`. The answer is where the library put it. */
export function moveBoundaryPx(
  state: PlaneState, box: PlaneBox, axis: "x" | "y", line: number, px: number,
): PlaneState | null {
  const plane = grid(state, box);
  if (!plane.hasBoundary(axis, line)) return null;
  plane.moveBoundary(axis, line, px, false);
  return plane.toJSON();
}
