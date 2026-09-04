import { describe, it, expect } from "vitest";
import {
  initialSidebarLayout,
  reconcileSidebarLayout,
  moveSidebarView,
  sidebarViewKeys,
  activeKeysOf,
  type SidebarLayout,
} from "./sidebarLayout";
import { leavesOf, type SplitTree } from "./splitTree";

// Left sidebar layout = SplitTree<SidebarGroup>. leaf = tab group (viewKeys + active), split = vertical split.
// SplitTree is reused so drag-merge matches the content area. Reconciled against registered views (add/remove).

let sid = 0;
const newSplitId = () => `S${++sid}`;

const single = (keys: string[]): SidebarLayout => ({
  type: "leaf",
  value: { viewKeys: keys, activeViewKey: keys[0] ?? "" },
});

describe("initialSidebarLayout", () => {
  it("puts every registered view in one leaf tab group, first view active", () => {
    const l = initialSidebarLayout(["a.x", "b.y"]);
    expect(l).toEqual(single(["a.x", "b.y"]));
  });
  it("empty registration = empty leaf", () => {
    expect(initialSidebarLayout([])).toEqual(single([]));
  });
});

describe("reconcileSidebarLayout", () => {
  it("adds a newly registered view to the first leaf tabs", () => {
    const l = single(["a.x"]);
    const r = reconcileSidebarLayout(l, ["a.x", "b.y"]);
    expect(sidebarViewKeys(r)).toEqual(["a.x", "b.y"]);
  });

  it("removes a view that is gone and collapses the empty leaf", () => {
    sid = 0;
    const split: SidebarLayout = {
      type: "split",
      id: "spl-aaaaaa",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [single(["a.x"]), single(["b.y"])],
    };
    const r = reconcileSidebarLayout(split, ["a.x"]); // b.y unregistered
    expect(r).toEqual(single(["a.x"])); // b.y leaf removed -> collapsed
  });

  it("corrects the leaf active view to the first view when the active view is gone", () => {
    const l: SidebarLayout = {
      type: "leaf",
      value: { viewKeys: ["a.x", "b.y"], activeViewKey: "b.y" },
    };
    const r = reconcileSidebarLayout(l, ["a.x"]); // b.y removed, it was the active one
    const g = (r as Extract<SidebarLayout, { type: "leaf" }>).value;
    expect(g.viewKeys).toEqual(["a.x"]);
    expect(g.activeViewKey).toBe("a.x");
  });

  it("unchanged input stays as is, key order and active preserved", () => {
    const l: SidebarLayout = {
      type: "leaf",
      value: { viewKeys: ["a.x", "b.y"], activeViewKey: "b.y" },
    };
    expect(reconcileSidebarLayout(l, ["a.x", "b.y"])).toEqual(l);
  });
});

describe("moveSidebarView (drag-merge)", () => {
  it("center: moves the tab to another leaf, removed from the source leaf, added and activated in the target leaf", () => {
    sid = 0;
    const split: SidebarLayout = {
      type: "split",
      id: "spl-aaaaaa",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [single(["a.x", "b.y"]), single(["c.z"])],
    };
    // Move a.x into the second leaf (c.z group) with center
    const r = moveSidebarView(split, "a.x", { type: "into", targetKey: "c.z" }, newSplitId);
    const groups = leavesOf(r as SplitTree<{ viewKeys: string[]; activeViewKey: string }>);
    expect(groups[0].viewKeys).toEqual(["b.y"]); // a.x removed
    expect(groups[1].viewKeys).toEqual(["c.z", "a.x"]); // a.x joined
    expect(groups[1].activeViewKey).toBe("a.x"); // moved = active
  });

  it("split col: splits vertically below the target", () => {
    sid = 0;
    const l = single(["a.x", "b.y"]);
    const r = moveSidebarView(l, "b.y", { type: "split", targetKey: "a.x", dir: "col", before: false }, newSplitId);
    const s = r as Extract<SidebarLayout, { type: "split" }>;
    expect(s.type).toBe("split");
    expect(s.dir).toBe("col");
    expect(leavesOf(s).map((g) => g.viewKeys)).toEqual([["a.x"], ["b.y"]]);
  });

  it("split row: splits horizontally to the left of the target, four directions, same as content", () => {
    sid = 0;
    const l = single(["a.x", "b.y"]);
    const r = moveSidebarView(l, "b.y", { type: "split", targetKey: "a.x", dir: "row", before: true }, newSplitId);
    const s = r as Extract<SidebarLayout, { type: "split" }>;
    expect(s.dir).toBe("row");
    expect(leavesOf(s).map((g) => g.viewKeys)).toEqual([["b.y"], ["a.x"]]); // before = left
  });

  it("splitting the last remaining view is meaningless -> no change", () => {
    sid = 0;
    const l = single(["a.x"]);
    const r = moveSidebarView(l, "a.x", { type: "split", targetKey: "a.x", dir: "col", before: false }, newSplitId);
    expect(r).toEqual(l);
  });
});

describe("activeKeysOf", () => {
  it("collects the active viewKey of each leaf, the views to render", () => {
    const split: SidebarLayout = {
      type: "split",
      id: "spl-aaaaaa",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", value: { viewKeys: ["a.x", "b.y"], activeViewKey: "b.y" } },
        { type: "leaf", value: { viewKeys: ["c.z"], activeViewKey: "c.z" } },
      ],
    };
    expect(activeKeysOf(split).sort()).toEqual(["b.y", "c.z"]);
  });
});
