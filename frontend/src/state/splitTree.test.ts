import { describe, it, expect } from "vitest";
import {
  equalSizes,
  splitLeaf,
  resizeSplitTree,
  findSplitTree,
  leavesOf,
  mapLeaves,
  removeLeaf,
  insertBeside,
  serializeSplitTree,
  deserializeSplitTree,
  type SplitTree,
} from "./splitTree";

// Generic split-tree — one abstraction shared by view groups and terminal panes, independent of the
// leaf payload L. These tests enforce the operation and serialization invariants with L=string
// (paneId-like).

let n = 0;
const newId = () => `s${++n}`;

function split<L>(
  id: string,
  dir: "row" | "col",
  sizes: number[],
  children: SplitTree<L>[],
): SplitTree<L> {
  return { type: "split", id, dir, sizes, children };
}

describe("equalSizes", () => {
  it("equal shares that sum to 1", () => {
    expect(equalSizes(2)).toEqual([0.5, 0.5]);
    expect(equalSizes(4).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});

describe("resizeSplitTree", () => {
  it("only the matching splitId node's sizes are replaced (immutable, nested)", () => {
    const t = split("a", "row", [0.5, 0.5], [
      splitLeaf("p1"),
      split("b", "col", [0.5, 0.5], [splitLeaf("p2"), splitLeaf("p3")]),
    ]);
    const r = resizeSplitTree(t, "b", [0.7, 0.3]);
    expect(r).not.toBe(t); // immutable (a new object)
    const inner = (r as Extract<typeof r, { type: "split" }>).children[1];
    expect((inner as Extract<typeof inner, { type: "split" }>).sizes).toEqual([0.7, 0.3]);
    // Parent unchanged
    expect((r as Extract<typeof r, { type: "split" }>).sizes).toEqual([0.5, 0.5]);
  });

  it("a sizes length that does not match children is ignored", () => {
    const t = split("a", "row", [0.5, 0.5], [splitLeaf("p1"), splitLeaf("p2")]);
    expect(resizeSplitTree(t, "a", [0.3, 0.3, 0.4])).toEqual(t);
  });
});

describe("findSplitTree / leavesOf", () => {
  const t = split("a", "row", [0.5, 0.5], [
    splitLeaf("p1"),
    split("b", "col", [0.5, 0.5], [splitLeaf("p2"), splitLeaf("p3")]),
  ]);
  it("whether a split id is present", () => {
    expect(findSplitTree(t, "b")).toBe(true);
    expect(findSplitTree(t, "zzz")).toBe(false);
  });
  it("leaf values collected in order", () => {
    expect(leavesOf(t)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("mapLeaves", () => {
  it("every leaf value is mapped, structure and sizes preserved", () => {
    const t = split("a", "row", [0.7, 0.3], [
      splitLeaf("p1"),
      split("b", "col", [0.5, 0.5], [splitLeaf("p2"), splitLeaf("p3")]),
    ]);
    const up = mapLeaves(t, (v) => v.toUpperCase());
    expect(leavesOf(up)).toEqual(["P1", "P2", "P3"]);
    const s = up as Extract<SplitTree<string>, { type: "split" }>;
    expect(s.sizes).toEqual([0.7, 0.3]);
  });

  it("branching inside fn maps only the chosen leaf", () => {
    const t = split("a", "row", [0.5, 0.5], [splitLeaf("p1"), splitLeaf("p2")]);
    const r = mapLeaves(t, (v) => (v === "p2" ? "X" : v));
    expect(leavesOf(r)).toEqual(["p1", "X"]);
  });
});

describe("removeLeaf", () => {
  it("a split with one child left after a removal collapses", () => {
    const t = split("a", "row", [0.5, 0.5], [splitLeaf("p1"), splitLeaf("p2")]);
    const { tree, removed } = removeLeaf(t, (v) => v === "p2");
    expect(removed).toBe("p2");
    expect(tree).toEqual(splitLeaf("p1")); // collapsed
  });

  it("removing one of three children → the rest stay and sizes renormalise to equal", () => {
    const t = split("a", "row", [0.6, 0.2, 0.2], [
      splitLeaf("p1"),
      splitLeaf("p2"),
      splitLeaf("p3"),
    ]);
    const { tree } = removeLeaf(t, (v) => v === "p2");
    const s = tree as Extract<SplitTree<string>, { type: "split" }>;
    expect(leavesOf(s)).toEqual(["p1", "p3"]);
    expect(s.sizes).toEqual([0.5, 0.5]); // the count changed → equal shares
  });

  it("removing everything gives null", () => {
    const t = splitLeaf("p1");
    expect(removeLeaf(t, () => true)).toEqual({ tree: null, removed: "p1" });
  });
});

describe("insertBeside", () => {
  it("splitting a leaf → a new split (dir, before order, equal sizes)", () => {
    n = 0;
    const t = splitLeaf("p1");
    const r = insertBeside(t, (v) => v === "p1", "row", false, "p2", newId);
    expect(r).toEqual(
      split("s1", "row", [0.5, 0.5], [splitLeaf("p1"), splitLeaf("p2")]),
    );
  });

  it("before=true puts the new leaf first", () => {
    n = 0;
    const t = splitLeaf("p1");
    const r = insertBeside(t, (v) => v === "p1", "col", true, "p2", newId);
    expect(leavesOf(r)).toEqual(["p2", "p1"]);
  });

  it("a direct sibling in a split of the same dir is inserted without nesting, sizes equal", () => {
    const t = split("a", "row", [0.5, 0.5], [splitLeaf("p1"), splitLeaf("p2")]);
    const r = insertBeside(t, (v) => v === "p1", "row", false, "p3", newId);
    const s = r as Extract<SplitTree<string>, { type: "split" }>;
    expect(s.id).toBe("a"); // the existing split is kept (no nesting)
    expect(leavesOf(s)).toEqual(["p1", "p3", "p2"]);
    expect(s.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
});

describe("serialize/deserialize round trip", () => {
  it("structure, order, sizes and leaf values survive; split ids are regenerated", () => {
    const t = split("OLD-a", "row", [0.7, 0.3], [
      splitLeaf("p1"),
      split("OLD-b", "col", [0.4, 0.6], [splitLeaf("p2"), splitLeaf("p3")]),
    ]);
    const snap = serializeSplitTree(t, (v) => v);
    // Serialization holds no split id (regenerated on load).
    expect(JSON.stringify(snap)).not.toContain("OLD-");
    n = 100;
    const back = deserializeSplitTree(snap, (s) => s, newId);
    // Structure, order, sizes, and leaves identical
    expect(leavesOf(back)).toEqual(["p1", "p2", "p3"]);
    const bs = back as Extract<SplitTree<string>, { type: "split" }>;
    expect(bs.dir).toBe("row");
    expect(bs.sizes).toEqual([0.7, 0.3]);
    const inner = bs.children[1] as Extract<SplitTree<string>, { type: "split" }>;
    expect(inner.sizes).toEqual([0.4, 0.6]);
    // Ids are newly generated (not OLD-)
    expect(bs.id).not.toBe("OLD-a");
    expect(bs.id.startsWith("s")).toBe(true);
  });

  it("the leaf converters map the payload (L→S, S→L)", () => {
    const t = split("a", "row", [0.5, 0.5], [splitLeaf(1), splitLeaf(2)]);
    const snap = serializeSplitTree(t, (v: number) => String(v));
    const back = deserializeSplitTree(snap, (s) => Number(s), newId);
    expect(leavesOf(back)).toEqual([1, 2]);
  });
});
