// The pane plane of a space — the one file that reads or writes split-pane state.
//
// A space holds its panes on one plane of shared grid lines (split-pane R1). The plane is the
// library's: the core names a pane, a side or a boundary and reads back the state the library
// produced. No rect, divider or drop zone is computed here or anywhere else in the core; the host
// component asks the same library through a `SplitPaneView` in px, and a command asks through the
// functions below with the plane size the host measured (`planeBox`).
//
// The rail is a card on this plane (split-pane R2): a fixed card of a declared width that reaches
// across every row. It stands on the plane while a set stands in it, and it is stored with the
// plane; when it withdraws, the library's R5 gives the width back to the slot it took it from, so
// the panes keep their proportions.
//
// Every operation is a pure function: state in, state out, `null` when the library refused.

import {
  SplitPane, checkState,
  type Side, type SplitPaneState,
} from "split-pane";
import { CHROME_BANDS } from "../lib/chromeBands";

export type PlaneState = SplitPaneState;
export type { Side };

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

/** The plane without `paneId`; its neighbours grow over the room (split-pane R7). */
export function closePane(state: PlaneState, box: PlaneBox, paneId: string): PlaneState | null {
  if (!hasPane(state, paneId)) return null;
  const plane = grid(state, box);
  return plane.close(paneId) ? plane.toJSON() : null;
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

/** The two slots meeting at a boundary, as shares of their sum. */
export function boundaryShares(
  state: PlaneState, axis: "x" | "y", line: number,
): [number, number] {
  const lines = axis === "x" ? state.xs : state.ys;
  const before = lines[line] - lines[line - 1];
  const after = lines[line + 1] - lines[line];
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

/** The plane with the rail standing on `line` at `widthPx`, fixed. A rail already there is moved. */
export function standRail(
  state: PlaneState, box: PlaneBox, line: number, widthPx: number,
): PlaneState | null {
  const plane = grid(state, box);
  if (plane.card(RAIL_CARD)) {
    if (plane.card(RAIL_CARD)!.c0 !== line && !plane.moveTo(RAIL_CARD, "x", line)) return null;
    plane.setSize(RAIL_CARD, "x", widthPx);
    return plane.toJSON();
  }
  if (plane.insertAt("x", line, { id: RAIL_CARD, size: widthPx }) === null) return null;
  plane.setFixed(RAIL_CARD, true);
  return plane.toJSON();
}

/** The plane without the rail. The room goes back to the slot beside it (split-pane R5). */
export function withdrawRail(state: PlaneState, box: PlaneBox): PlaneState {
  if (!hasRail(state)) return state;
  const plane = grid(state, box);
  plane.setFixed(RAIL_CARD, false);
  plane.close(RAIL_CARD);
  return plane.toJSON();
}

/** The line the rail stands on, or null. */
export function railLine(state: PlaneState): number | null {
  return state.cards.find((c) => c.id === RAIL_CARD)?.c0 ?? null;
}

/**
 * A plane showing one pane over the whole space, with the rail at its left when one stands on
 * the plane it came from. This is a presentation of the space, not a change to its layout.
 */
export function soloPlane(state: PlaneState, paneId: string): PlaneState {
  const rail = state.cards.find((c) => c.id === RAIL_CARD);
  if (!rail) return singlePane(paneId);
  return {
    xs: [0, 0, 1],
    ys: [0, 1],
    cards: [
      { id: RAIL_CARD, c0: 0, c1: 1, r0: 0, r1: 1, width: rail.width, fixed: true },
      { id: paneId, c0: 1, c1: 2, r0: 0, r1: 1 },
    ],
  };
}
