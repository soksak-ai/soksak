// Gutter address resolution — the only way to name a seam without naming an internal node of the
// layout tree.
//
// [Rule] Internal (split) nodes have no name (IDENTITY §4). But a seam is an operation target, so
// it must be nameable. A lemma reconciles the two: **every gutter coincides with the right/bottom
// edge of some pane.** The seam between children cᵢ and cᵢ₊₁ of node N (axis A) is the trailing
// face of cᵢ, and cᵢ's subtree always contains a leaf touching that face — descend to the last
// child when cᵢ shares N's axis, to any child when perpendicular, and the recursion is finite. So
// there is never a need to name the nameless.
//
// The canonical form is the right|bottom of **the first pane in document order touching that
// gutter** (any other pane's edge is an alias, and responses are always converted back to the
// canonical form). Because the first leaf in document order is chosen, a perpendicular branch
// descends to the first child — this is where the canonical form narrows the lemma's "any child"
// to one.
//
// left|top are input aliases: they mean that pane's leading seam, and the canonical form of the
// same gutter comes from the preceding sibling. Aliases are resolved but never returned (one
// canonical form only).
//
// This file holds pure functions only — it reads the tree and returns values, with no knowledge of
// the DOM or stores. GroupArea takes the data-node address and hover key, and the command layer
// takes parameter resolution, from the same functions (no second source of truth).

import type { SplitTree } from "../state/splitTree";

/** Two canonical directions plus two input aliases. */
export type GutterSide = "right" | "bottom" | "left" | "top";
export type CanonicalSide = "right" | "bottom";

/** A row split's seam is vertical, so it is the left cell's right edge; a col split's is the top cell's bottom edge. */
export const canonicalSide = (dir: "row" | "col"): CanonicalSide =>
  dir === "row" ? "right" : "bottom";

/** The split axis for that direction. right|left = row (vertical seam), bottom|top = col. */
export const axisOfSide = (side: GutterSide): "row" | "col" =>
  side === "right" || side === "left" ? "row" : "col";

/** Is this a canonical direction — otherwise it is an alias for the leading seam. */
export const isCanonicalSide = (side: GutterSide): side is CanonicalSide =>
  side === "right" || side === "bottom";

/** One place for the address string — assembling the format in two places makes them diverge. */
export const gutterAddress = (paneId: string, side: CanonicalSide): string =>
  `gutter/${paneId}/${side}`;

/** First leaf in document order touching that axis's trailing face in the subtree. The lemma's recursion verbatim. */
function firstLeafOnTrailingFace<L>(node: SplitTree<L>, axis: "row" | "col"): L {
  if (node.type === "leaf") return node.value;
  const next =
    node.dir === axis
      ? node.children[node.children.length - 1] // Same axis — the last child holds the trailing face
      : node.children[0]; // Cross axis — every child touches that face, so the first in document order is canonical
  return firstLeafOnTrailingFace(next, axis);
}

/** Find a split node by splitId (internal — this id never leaves the module). */
function splitNodeById<L>(
  node: SplitTree<L>,
  splitId: string,
): Extract<SplitTree<L>, { type: "split" }> | null {
  if (node.type === "leaf") return null;
  if (node.id === splitId) return node;
  for (const c of node.children) {
    const hit = splitNodeById(c, splitId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Internal coordinate (splitId, index) → the two parts of a canonical gutter address. Renderer
 * only — the renderer already has the tree, converts it to the named coordinate there, and writes
 * it into the DOM. Only the result leaves the module.
 */
export function gutterOwnerOf<L>(
  tree: SplitTree<L>,
  splitId: string,
  index: number,
  idOf: (leaf: L) => string,
): { pane: string; side: CanonicalSide } | null {
  const node = splitNodeById(tree, splitId);
  if (!node) return null;
  if (index < 0 || index >= node.children.length - 1) return null; // No gutter after the last child
  return {
    pane: idOf(firstLeafOnTrailingFace(node.children[index], node.dir)),
    side: canonicalSide(node.dir),
  };
}

/** Path from root to that leaf. Each step records "which child index of this split was taken". */
function pathToLeaf<L>(
  node: SplitTree<L>,
  paneId: string,
  idOf: (leaf: L) => string,
): { node: Extract<SplitTree<L>, { type: "split" }>; childIndex: number }[] | null {
  if (node.type === "leaf") return idOf(node.value) === paneId ? [] : null;
  for (let i = 0; i < node.children.length; i++) {
    const below = pathToLeaf(node.children[i], paneId, idOf);
    if (below) return [{ node, childIndex: i }, ...below];
  }
  return null;
}

/**
 * Gutter address → internal coordinate. The inverse is unique: the gutter is owned by the
 * **nearest same-axis ancestor** in which the pane's subtree is not the last child (for an alias
 * direction, the nearest ancestor in which it is not the first child, and its leading seam).
 * Unresolvable → null: that edge of that pane has no gutter (an outer edge of the layout).
 */
export function resolveGutter<L>(
  tree: SplitTree<L>,
  paneId: string,
  side: GutterSide,
  idOf: (leaf: L) => string,
): { splitId: string; index: number } | null {
  const path = pathToLeaf(tree, paneId, idOf);
  if (!path) return null;
  const axis = axisOfSide(side);
  const trailing = isCanonicalSide(side);
  for (let i = path.length - 1; i >= 0; i--) {
    const { node, childIndex } = path[i];
    if (node.dir !== axis) continue;
    if (trailing) {
      if (childIndex < node.children.length - 1) {
        return { splitId: node.id, index: childIndex };
      }
    } else if (childIndex > 0) {
      return { splitId: node.id, index: childIndex - 1 };
    }
  }
  return null;
}

/**
 * Convert an alias back to the canonical form — a response always states one canonical address
 * (IDENTITY §4·§6). An unresolvable edge returns null.
 */
export function canonicalGutter<L>(
  tree: SplitTree<L>,
  paneId: string,
  side: GutterSide,
  idOf: (leaf: L) => string,
): { pane: string; side: CanonicalSide } | null {
  const inner = resolveGutter(tree, paneId, side, idOf);
  if (!inner) return null;
  return gutterOwnerOf(tree, inner.splitId, inner.index, idOf);
}
