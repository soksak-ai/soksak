// Gutter address resolution gate — checks on an actual tree the theorem (IDENTITY §4) that every
// seam is addressable without naming an internal node.
//
// Four rules held here:
//   ① Totality — the gutter count of the tree equals the count of resolved canonical addresses (a
//      missing seam leaves that gutter with no name, and a control surface with no name is the
//      same as absent).
//   ② Uniqueness — one canonical address per gutter (two means a response writes one gutter under
//      two names).
//   ③ Round trip — mapping a canonical address back to internal coordinates gives the gutter it
//      started from.
//   ④ Alias — left|top resolve to the preceding seam and map back to the canonical form.
//
// Three fixture shapes: flat row, same-axis nesting (the theorem's "descend to the last child"),
// and perpendicular nesting (the theorem's "any child" — where canonical narrows to the first
// child in document order).
import { describe, expect, it } from "vitest";
import type { SplitTree } from "../state/splitTree";
import {
  canonicalGutter,
  canonicalSide,
  gutterAddress,
  gutterOwnerOf,
  resolveGutter,
} from "./gutterAddress";

type Cell = { id: string };
const leaf = (id: string): SplitTree<Cell> => ({ type: "leaf", value: { id } });
const split = (
  id: string,
  dir: "row" | "col",
  children: SplitTree<Cell>[],
): SplitTree<Cell> => ({
  type: "split",
  id,
  dir,
  sizes: children.map(() => 1 / children.length),
  children,
});
const idOf = (c: Cell) => c.id;

/** Collects every gutter in the tree as internal coordinates — the denominator of the expectation (①). */
function allGutters(node: SplitTree<Cell>): { splitId: string; index: number }[] {
  if (node.type === "leaf") return [];
  const own = node.children.slice(0, -1).map((_, i) => ({ splitId: node.id, index: i }));
  return [...own, ...node.children.flatMap(allGutters)];
}

// Row of three cells: a | b | c → two gutters (a.right, b.right)
const flatRow = split("s0", "row", [leaf("pan-a"), leaf("pan-b"), leaf("pan-c")]);

// Same-axis nesting: (a | (b | c)) | d — the inner split is a row too.
const sameAxis = split("s0", "row", [
  leaf("pan-a"),
  split("s1", "row", [leaf("pan-b"), leaf("pan-c")]),
  leaf("pan-d"),
]);

// Perpendicular nesting: (b over c) | d — the row's first child is a col, so both b and c touch the right face.
const perpendicular = split("s0", "row", [
  split("s1", "col", [leaf("pan-b"), leaf("pan-c")]),
  leaf("pan-d"),
]);

describe("① totality · ② uniqueness — every gutter has exactly one canonical address", () => {
  for (const [name, tree] of [
    ["flat row", flatRow],
    ["same-axis nesting", sameAxis],
    ["perpendicular nesting", perpendicular],
  ] as const) {
    it(`${name}: gutter count = canonical address count, no duplicates`, () => {
      const gutters = allGutters(tree);
      const owners = gutters.map((g) => gutterOwnerOf(tree, g.splitId, g.index, idOf));
      expect(owners.every((o) => o !== null)).toBe(true);
      const addrs = owners.map((o) => gutterAddress(o!.pane, o!.side));
      expect(addrs.length).toBe(gutters.length);
      expect(new Set(addrs).size).toBe(addrs.length);
    });
  }

  it("the canonical of a flat row is the left cell's right", () => {
    expect(gutterOwnerOf(flatRow, "s0", 0, idOf)).toEqual({ pane: "pan-a", side: "right" });
    expect(gutterOwnerOf(flatRow, "s0", 1, idOf)).toEqual({ pane: "pan-b", side: "right" });
  });

  it("the canonical of a col split is the upper cell's bottom", () => {
    const t = split("s0", "col", [leaf("pan-a"), leaf("pan-b")]);
    expect(gutterOwnerOf(t, "s0", 0, idOf)).toEqual({ pane: "pan-a", side: "bottom" });
    expect(canonicalSide("col")).toBe("bottom");
  });

  it("same-axis nesting descends to the last child — the right face of the s1 subtree is c's", () => {
    expect(gutterOwnerOf(sameAxis, "s0", 1, idOf)).toEqual({ pane: "pan-c", side: "right" });
  });

  it("perpendicular nesting descends to the first child in document order — b and c both touch it, and the canonical is b alone", () => {
    expect(gutterOwnerOf(perpendicular, "s0", 0, idOf)).toEqual({
      pane: "pan-b",
      side: "right",
    });
  });

  it("there is no gutter after the last child — nothing absent gets an address", () => {
    expect(gutterOwnerOf(flatRow, "s0", 2, idOf)).toBeNull();
    expect(gutterOwnerOf(flatRow, "s0", -1, idOf)).toBeNull();
    expect(gutterOwnerOf(flatRow, "s-none", 0, idOf)).toBeNull();
  });
});

describe("③ round trip — a canonical address mapped back to internal coordinates is the gutter it started from", () => {
  for (const [name, tree] of [
    ["flat row", flatRow],
    ["same-axis nesting", sameAxis],
    ["perpendicular nesting", perpendicular],
  ] as const) {
    it(`${name}: every gutter round-trips`, () => {
      for (const g of allGutters(tree)) {
        const owner = gutterOwnerOf(tree, g.splitId, g.index, idOf)!;
        expect(resolveGutter(tree, owner.pane, owner.side, idOf)).toEqual(g);
      }
    });
  }

  it("an outer edge of the layout does not resolve — the last cell's right has no gutter", () => {
    expect(resolveGutter(flatRow, "pan-c", "right", idOf)).toBeNull();
    expect(resolveGutter(flatRow, "pan-a", "left", idOf)).toBeNull();
    expect(resolveGutter(flatRow, "pan-a", "bottom", idOf)).toBeNull();
  });

  it("a pane that is not in the tree is null — no guessing", () => {
    expect(resolveGutter(flatRow, "pan-zzz", "right", idOf)).toBeNull();
  });
});

describe("④ alias — left|top are the preceding seam and map back to the canonical form", () => {
  it("b.left and a.right are the same gutter", () => {
    expect(resolveGutter(flatRow, "pan-b", "left", idOf)).toEqual(
      resolveGutter(flatRow, "pan-a", "right", idOf),
    );
    expect(canonicalGutter(flatRow, "pan-b", "left", idOf)).toEqual({
      pane: "pan-a",
      side: "right",
    });
  });

  it("top follows the same rule — it maps back to the upper cell's bottom", () => {
    const t = split("s0", "col", [leaf("pan-a"), leaf("pan-b")]);
    expect(canonicalGutter(t, "pan-b", "top", idOf)).toEqual({
      pane: "pan-a",
      side: "bottom",
    });
  });

  it("a canonical side in gives the canonical out — idempotent", () => {
    expect(canonicalGutter(flatRow, "pan-a", "right", idOf)).toEqual({
      pane: "pan-a",
      side: "right",
    });
  });

  it("the gutter an alias names can have a different canonical pane — under nesting an alias cannot use its own name", () => {
    // d.left = gutter 0 of s0. Its canonical is the first leaf in document order of the left subtree (col) = b.
    expect(canonicalGutter(perpendicular, "pan-d", "left", idOf)).toEqual({
      pane: "pan-b",
      side: "right",
    });
  });
});

describe("the address string is assembled in one place", () => {
  it("gutter/<pan-id>/<right|bottom>", () => {
    expect(gutterAddress("pan-a", "right")).toBe("gutter/pan-a/right");
    expect(gutterAddress("pan-b", "bottom")).toBe("gutter/pan-b/bottom");
  });
});
