// The split tree holds at the scale a person can actually reach.
//
// The unit tests below it check one operation at a time on a tree of three or
// four leaves. That proves the rule and not the structure: a nesting bug, a
// sizes array that drifts out of step with children, or a sibling that is not
// inherited on close all survive a small tree and appear only after a person
// has been splitting for a while.
//
// So this drives the real operations 64 times and checks the invariants after
// every one. 64 is the number the plan names as the gate for G2.
import { describe, expect, it } from "vitest";
import {
  equalSizes,
  insertBeside,
  leavesOf,
  removeLeaf,
  splitLeaf,
  type SplitTree,
} from "./splitTree";
import { computeSplitLayout } from "../lib/splitLayout";

/** Split ids are minted here so a failure names the split that produced it. */
function issuer(): () => string {
  let next = 0;
  return () => `spl-${(next++).toString(36).padStart(6, "0")}`;
}

/**
 * Every invariant of the structure, checked at once.
 *
 * They are checked together because they fail together: a split whose sizes
 * and children disagree is also a split that renders at the wrong width, and
 * reporting one without the other sends the reader to the wrong file.
 */
function invariants<L>(node: SplitTree<L>, path = "root"): string[] {
  if (node.type === "leaf") return [];
  const broken: string[] = [];
  const here = `${path}/${node.id}`;
  if (node.children.length < 2) {
    broken.push(`${here}: a split holds ${node.children.length} children; a split of one is a leaf`);
  }
  if (node.sizes.length !== node.children.length) {
    broken.push(`${here}: ${node.sizes.length} sizes for ${node.children.length} children`);
  }
  const sum = node.sizes.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    broken.push(`${here}: sizes sum to ${sum}, not 1`);
  }
  if (node.sizes.some((s) => !(s > 0))) {
    broken.push(`${here}: a size is not positive (${node.sizes.join(", ")})`);
  }
  for (const child of node.children) {
    if (child.type === "split" && child.dir === node.dir) {
      broken.push(`${here}: a ${node.dir} split nests a ${child.dir} split — a sibling was expected`);
    }
    broken.push(...invariants(child, here));
  }
  return broken;
}

/** Every split id in the tree, in order. */
function splitIds<L>(node: SplitTree<L>): string[] {
  return node.type === "leaf" ? [] : [node.id, ...node.children.flatMap(splitIds)];
}

describe("the split tree at 64 splits", () => {
  it("64 splits along one direction become 65 siblings, not 64 nestings", () => {
    // The invariant that matters here is the sibling insert. Alternating the
    // direction would avoid same-direction nesting by construction and prove
    // nothing about it — measured 2026-08-16: with the sibling path disabled,
    // an alternating run stayed green.
    const newSplitId = issuer();
    let tree: SplitTree<string> = splitLeaf("pan-000000");

    for (let step = 1; step <= 64; step += 1) {
      tree = insertBeside(
        tree,
        (v) => v === `pan-${(step - 1).toString().padStart(6, "0")}`,
        "row",
        false,
        `pan-${step.toString().padStart(6, "0")}`,
        newSplitId,
      );
      expect(invariants(tree), `after split ${step}`).toEqual([]);
      expect(leavesOf(tree), `after split ${step}`).toHaveLength(step + 1);
    }

    expect(splitIds(tree), "one row split, not a chain of them").toHaveLength(1);
    expect(tree.type === "split" && tree.children).toHaveLength(65);
  });

  it("64 splits alternating direction leave 65 leaves and no broken invariant", () => {
    const newSplitId = issuer();
    let tree: SplitTree<string> = splitLeaf("pan-000000");

    for (let step = 1; step <= 64; step += 1) {
      const target = `pan-${(step - 1).toString().padStart(6, "0")}`;
      const fresh = `pan-${step.toString().padStart(6, "0")}`;
      // Alternating direction is what produces nesting; splitting along one
      // axis only would keep the tree flat and prove nothing about depth.
      tree = insertBeside(tree, (v) => v === target, step % 2 ? "row" : "col", false, fresh, newSplitId);

      const broken = invariants(tree);
      expect(broken, `after split ${step}`).toEqual([]);
      expect(leavesOf(tree), `after split ${step}`).toHaveLength(step + 1);
    }

    const ids = splitIds(tree);
    expect(new Set(ids).size, "a split id was reused").toBe(ids.length);
  });

  it("closing takes the sibling's place rather than leaving a split of one", () => {
    const newSplitId = issuer();
    let tree: SplitTree<string> = splitLeaf("pan-000000");
    for (let step = 1; step <= 64; step += 1) {
      tree = insertBeside(
        tree,
        (v) => v === `pan-${(step - 1).toString().padStart(6, "0")}`,
        step % 2 ? "row" : "col",
        false,
        `pan-${step.toString().padStart(6, "0")}`,
        newSplitId,
      );
    }

    // Closed newest first, which is the order a person undoes their own splits.
    for (let step = 64; step >= 1; step -= 1) {
      const going = `pan-${step.toString().padStart(6, "0")}`;
      const { tree: after, removed } = removeLeaf(tree, (v) => v === going);
      expect(removed, `closing ${going}`).toBe(going);
      expect(after, `closing ${going} emptied the tree`).not.toBeNull();
      tree = after!;
      expect(invariants(tree), `after closing ${going}`).toEqual([]);
      expect(leavesOf(tree), `after closing ${going}`).toHaveLength(step);
    }

    expect(tree).toEqual(splitLeaf("pan-000000"));
  });

  it("the last leaf is not closed — removeLeaf answers null and the caller refuses", () => {
    // The tree itself has no opinion about a minimum; it answers null, and the
    // command layer turns that into LAST_ITEM. Checked here so a change to the
    // structure cannot quietly start answering an empty tree.
    const only = splitLeaf("pan-000000");
    const { tree, removed } = removeLeaf(only, (v) => v === "pan-000000");
    expect(removed).toBe("pan-000000");
    expect(tree).toBeNull();
  });

  it("a size array that does not match its children is refused, at depth", () => {
    const newSplitId = issuer();
    let tree: SplitTree<string> = splitLeaf("pan-000000");
    for (let step = 1; step <= 8; step += 1) {
      tree = insertBeside(
        tree,
        (v) => v === `pan-${(step - 1).toString().padStart(6, "0")}`,
        step % 2 ? "row" : "col",
        false,
        `pan-${step.toString().padStart(6, "0")}`,
        newSplitId,
      );
    }
    // Planted: the invariant reader has to see a break several levels down, not
    // only at the root.
    const deepest = splitIds(tree).at(-1)!;
    const planted = JSON.parse(JSON.stringify(tree)) as SplitTree<string>;
    const walk = (n: SplitTree<string>): void => {
      if (n.type === "leaf") return;
      if (n.id === deepest) n.sizes = equalSizes(n.children.length + 1);
      n.children.forEach(walk);
    };
    walk(planted);
    expect(invariants(planted).join("\n")).toContain(deepest);
  });
});

describe("the rect a split tree lays out", () => {
  /** Splits `steps` times, each split beside the pane the last one made. */
  function grow(steps: number, dir: (step: number) => "row" | "col"): SplitTree<string> {
    const newSplitId = issuer();
    let tree: SplitTree<string> = splitLeaf("pan-000000");
    for (let step = 1; step <= steps; step += 1) {
      tree = insertBeside(
        tree,
        (v) => v === `pan-${(step - 1).toString().padStart(6, "0")}`,
        dir(step),
        false,
        `pan-${step.toString().padStart(6, "0")}`,
        newSplitId,
      );
    }
    return tree;
  }

  /**
   * The cells tile the plane: they fill it, they stay inside it, and no point
   * is inside two of them.
   *
   * A gap is a strip of window background showing between panes; an overlap is
   * one pane drawn over another. Neither appears in a two-leaf test, and both
   * are read as a rendering defect rather than a layout one.
   */
  function expectTiling(tree: SplitTree<string>, count: number): void {
    const { cells } = computeSplitLayout(tree);
    expect(cells).toHaveLength(count);

    // computeSplitLayout lays out onto 0..100 in both axes (percent), so the
    // area of the plane is 10000.
    const area = cells.reduce((sum, c) => sum + c.rect.width * c.rect.height, 0);
    expect(area, "the cells do not add up to the plane").toBeCloseTo(10000, 6);

    for (const c of cells) {
      expect(c.rect.width, `${c.value} has no width`).toBeGreaterThan(0);
      expect(c.rect.height, `${c.value} has no height`).toBeGreaterThan(0);
      expect(c.rect.left, `${c.value} starts left of the plane`).toBeGreaterThanOrEqual(-1e-9);
      expect(c.rect.top, `${c.value} starts above the plane`).toBeGreaterThanOrEqual(-1e-9);
      expect(c.rect.left + c.rect.width, `${c.value} runs past the right edge`).toBeLessThanOrEqual(100 + 1e-9);
      expect(c.rect.top + c.rect.height, `${c.value} runs past the bottom edge`).toBeLessThanOrEqual(100 + 1e-9);
    }

    // The centre of each cell is inside exactly one cell — its own. For
    // axis-aligned boxes that fill the plane this is enough: an overlap puts
    // some centre inside two, and a gap shows up in the area above.
    for (const c of cells) {
      const cx = c.rect.left + c.rect.width / 2;
      const cy = c.rect.top + c.rect.height / 2;
      const covering = cells.filter(
        (o) =>
          cx >= o.rect.left &&
          cx <= o.rect.left + o.rect.width &&
          cy >= o.rect.top &&
          cy <= o.rect.top + o.rect.height,
      );
      expect(covering.map((o) => o.value), `${c.value}'s centre lies in more than one cell`).toEqual([c.value]);
    }
  }

  it("65 siblings tile the plane exactly once", () => {
    expectTiling(grow(64, () => "row"), 65);
  });

  it("nested splits tile the plane exactly once", () => {
    // 12 alternating splits, not 64. Alternating halves one axis per step, so
    // by step 64 a cell is 100/2**32 wide — around 2e-8 of the plane, which is
    // small enough that float error and real overlap stop being separable.
    // Depth is what this checks, and 12 already nests six levels on each axis.
    expectTiling(grow(12, (step) => (step % 2 ? "row" : "col")), 13);
  });

  it("every gutter names a live split and sits on a cell boundary", () => {
    // A gutter whose splitId is not in the tree is a divider that drags
    // nothing, and a person reads that as a frozen window rather than a
    // missing id.
    const tree = grow(12, (step) => (step % 2 ? "row" : "col"));
    const { cells, gutters } = computeSplitLayout(tree);
    const ids = new Set(splitIds(tree));

    expect(gutters, "one gutter per seam between siblings").toHaveLength(12);
    for (const g of gutters) {
      expect(ids.has(g.splitId), `gutter on unknown split ${g.splitId}`).toBe(true);
      expect(g.sizes.length, `gutter on ${g.splitId} carries no sizes`).toBeGreaterThanOrEqual(2);
      const edge = g.dir === "row" ? g.rect.left : g.rect.top;
      const onEdge = cells.some((c) =>
        g.dir === "row"
          ? Math.abs(c.rect.left - edge) < 1e-9 || Math.abs(c.rect.left + c.rect.width - edge) < 1e-9
          : Math.abs(c.rect.top - edge) < 1e-9 || Math.abs(c.rect.top + c.rect.height - edge) < 1e-9,
      );
      expect(onEdge, `gutter on ${g.splitId} is not on a cell edge`).toBe(true);
    }
  });
});
