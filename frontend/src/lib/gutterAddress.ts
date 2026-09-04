// Gutter address resolution — how a boundary of the plane is named on the command surface and in
// the DOM.
//
// [Rule] A boundary is a line of the plane, and a line has an index that shifts when a line is
// added before it, so an index is not a name. A gutter is named by a pane and one of its edges,
// and the canonical form is the right|bottom edge of **the first pane in reading order** whose
// edge stands on that line (any other pane's edge is an alias, and responses are always converted
// back to the canonical form). left|top are input aliases: they mean that pane's leading edge.
// Aliases are resolved but never returned (one canonical form only).
//
// This file holds pure functions only — it reads the plane and returns values, with no knowledge
// of the DOM or stores. GroupArea takes the data-node address, and the command layer takes
// parameter resolution, from the same functions (no second source of truth).

import { boundaryOf, paneIds, type PlaneState } from "../state/panePlane";

/** Two canonical directions plus two input aliases. */
export type GutterSide = "right" | "bottom" | "left" | "top";
export type CanonicalSide = "right" | "bottom";

/** A vertical boundary is a pane's right edge; a horizontal one is a pane's bottom edge. */
export const canonicalSide = (axis: "x" | "y"): CanonicalSide =>
  axis === "x" ? "right" : "bottom";

/** Is this a canonical direction — otherwise it is an alias for the leading edge. */
export const isCanonicalSide = (side: GutterSide): side is CanonicalSide =>
  side === "right" || side === "bottom";

/** One place for the address string — assembling the format in two places makes them diverge. */
export const gutterAddress = (paneId: string, side: CanonicalSide): string =>
  `gutter/${paneId}/${side}`;

/**
 * The canonical name of a boundary: the first pane in reading order whose trailing edge stands on
 * it. Null for a border of the plane, which is no gutter.
 */
export function gutterOwnerOf(
  state: PlaneState,
  axis: "x" | "y",
  line: number,
): { pane: string; side: CanonicalSide } | null {
  const last = (axis === "x" ? state.xs : state.ys).length - 1;
  if (line <= 0 || line >= last) return null;
  const byId = new Map(state.cards.map((card) => [card.id, card]));
  for (const id of paneIds(state)) {
    const card = byId.get(id)!;
    if ((axis === "x" ? card.c1 : card.r1) === line) return { pane: id, side: canonicalSide(axis) };
  }
  return null;
}

/** Gutter address → the boundary. Null when that edge of that pane is a border of the plane. */
export function resolveGutter(
  state: PlaneState,
  paneId: string,
  side: GutterSide,
): { axis: "x" | "y"; line: number } | null {
  return boundaryOf(state, paneId, side);
}

/**
 * Convert an alias back to the canonical form — a response always states one canonical address
 * (IDENTITY §4·§6). An unresolvable edge returns null.
 */
export function canonicalGutter(
  state: PlaneState,
  paneId: string,
  side: GutterSide,
): { pane: string; side: CanonicalSide } | null {
  const inner = resolveGutter(state, paneId, side);
  return inner ? gutterOwnerOf(state, inner.axis, inner.line) : null;
}
