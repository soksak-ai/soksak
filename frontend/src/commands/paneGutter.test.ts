// Resize addressed by gutter — the runtime proof of the invariant that no layout-tree internal
// node id appears on the command surface (IDENTITY §4 · paneInvariant ③).
//
// Rule: every gutter coincides with some pane's right/bottom edge, so pane.resize and
// pane.equalize address a gutter as (pane, edge). The operation is complete without any word for
// an internal node.
//   ① (pane, right) = the gutter at that position in the nearest row ancestor where the pane's
//      subtree is not the last child.
//   ② left/top are aliases of the same gutter (the name used from the preceding sibling) — the
//      reply echoes the canonical form (the first pane's right/bottom).
//   ③ One gutter moves the two neighboring slots only. The remaining slots are unchanged and the
//      sum is 1.
//   ④ No gutter on that edge (the right of the rightmost pane) gives TARGET_NOT_FOUND — no other
//      gutter is moved by guessing.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()), invoke: vi.fn(async () => undefined) }));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { useSessions, type PaneNode, type Project, type Pane } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";

const pane = (id: string): Pane => ({ id, tabs: [], activeTabId: "" });
const leaf = (id: string): PaneNode => ({ type: "leaf", value: pane(id) });

/** row[ A | col[ B / C ] | D ] — nesting is required to observe the "nearest axis ancestor" rule. */
function fixture(): Project {
  return {
    id: "t1",
    title: "P",
    root: "<local-evidence>/pane-gutter",
    sidebarOpen: false,
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    spaces: [
      {
        id: "c1",
        title: "1",
        layout: {
          type: "split",
          id: "s1",
          dir: "row",
          sizes: [0.5, 0.3, 0.2],
          children: [
            leaf("pan-a"),
            {
              type: "split",
              id: "s2",
              dir: "col",
              sizes: [0.6, 0.4],
              children: [leaf("pan-b"), leaf("pan-c")],
            },
            leaf("pan-d"),
          ],
        },
        activePaneId: "pan-b",
      },
    ],
    activeSpaceId: "c1",
  };
}

/** row[ col[ row[ E | F ] / G ] | H ] — two ancestors share the row axis and neither is the last
 *  child. Only this shape observes whether the "nearest ancestor" rule actually holds (picking the
 *  far ancestor leaks E's right onto the gutter between col and H). */
function nestedRowFixture(): Project {
  const base = fixture();
  return {
    ...base,
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: "pan-e",
        layout: {
          type: "split",
          id: "s1",
          dir: "row",
          sizes: [0.7, 0.3],
          children: [
            {
              type: "split",
              id: "s2",
              dir: "col",
              sizes: [0.5, 0.5],
              children: [
                {
                  type: "split",
                  id: "s3",
                  dir: "row",
                  sizes: [0.4, 0.6],
                  children: [leaf("pan-e"), leaf("pan-f")],
                },
                leaf("pan-g"),
              ],
            },
            leaf("pan-h"),
          ],
        },
      },
    ],
  };
}

registerCatalog();

beforeEach(() => {
  useSessions.setState({ projects: [fixture()], activeId: "t1" });
});

const sizesOf = (): number[] => {
  const layout = useSessions.getState().projects[0].spaces[0].layout;
  if (layout.type !== "split") throw new Error("not a split");
  return layout.sizes;
};

const innerSizes = (): number[] => {
  const layout = useSessions.getState().projects[0].spaces[0].layout;
  if (layout.type !== "split") throw new Error("not a split");
  const inner = layout.children[1];
  if (inner.type !== "split") throw new Error("not a nested split");
  return inner.sizes;
};

describe("pane.resize — a seam is addressed as a pane edge", () => {
  it("① the first pane's right seam is the seam of that row slot — only two areas move and the rest stay unchanged", async () => {
    const r = await execute("pane.resize", { pane: "pan-a", edge: "right", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    // The two adjacent slots (0.5+0.3=0.8) become 0.25 : 0.75 — the third slot (0.2) is untouched.
    expect(sizesOf()).toEqual([0.2, 0.6000000000000001, 0.2]);
    expect(sizesOf().reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(r.data).toMatchObject({
      paneId: "pan-a",
      gutter: { pane: "pan-a", edge: "right" },
    });
  });

  it("② a nested pane's right is the seam of the nearest row ancestor — the canonical pane is the first one in document order", async () => {
    // pan-b is inside col and that col subtree is not row's last child → gutter 1 of the row.
    const r = await execute("pane.resize", { pane: "pan-b", edge: "right", ratio: 0.5 }, {});
    expect(r.ok).toBe(true);
    expect(sizesOf()).toEqual([0.5, 0.25, 0.25]);
    // First pane touching that gutter = first child of the col subtree (vertical, so all of them touch).
    expect(r.data).toMatchObject({ paneId: "pan-b", gutter: { pane: "pan-b", edge: "right" } });
  });

  it("② left is an alias for the same seam — it answers with the canonical pane and gives the ratio to the calling pane's side", async () => {
    const r = await execute("pane.resize", { pane: "pan-d", edge: "left", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    // pan-d is the trailing slot (0.2). Its sum with the preceding slot, 0.5, becomes 0.375 : 0.125 = 0.25 for pan-d.
    expect(sizesOf()).toEqual([0.5, 0.375, 0.125]);
    // Canonical is the first pane in document order touching that gutter — not the last child of
    // the preceding sibling (col) but its first child (pan-b), because the axis is vertical.
    expect(r.data).toMatchObject({
      paneId: "pan-d",
      gutter: { pane: "pan-b", edge: "right" },
    });
  });

  it("③ bottom is the seam on the col axis — one pane has a different seam per axis", async () => {
    const r = await execute("pane.resize", { pane: "pan-b", edge: "bottom", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    expect(innerSizes()).toEqual([0.25, 0.75]);
    expect(sizesOf()).toEqual([0.5, 0.3, 0.2]); // the outer row is unchanged
    expect(r.data).toMatchObject({ gutter: { pane: "pan-b", edge: "bottom" } });
  });

  it("④ TARGET_NOT_FOUND when that edge has no seam — no other seam is guessed and moved", async () => {
    const before = sizesOf();
    const r = await execute("pane.resize", { pane: "pan-d", edge: "right", ratio: 0.5 }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
    expect(sizesOf()).toEqual(before);
  });

  it("ratio must be between 0 and 1 — a boundary value removes an area", async () => {
    for (const ratio of [0, 1, -0.5, 1.5]) {
      const r = await execute("pane.resize", { pane: "pan-a", edge: "right", ratio }, {});
      expect(r.ok).toBe(false);
      expect(r.code).toBe("INVALID_PARAMS");
    }
  });

  it("the answer has no internal node id — a name the caller cannot address is not handed out", async () => {
    const r = await execute("pane.resize", { pane: "pan-a", edge: "right", ratio: 0.4 }, {});
    const text = JSON.stringify(r);
    expect(text).not.toContain("s1");
    expect(text).not.toContain("s2");
  });
});

describe("pane.equalize — equalize around a seam", () => {
  it("the default halves the two areas that seam divides — the rest stay unchanged", async () => {
    const r = await execute("pane.equalize", { pane: "pan-a", edge: "right" }, {});
    expect(r.ok).toBe(true);
    expect(sizesOf()).toEqual([0.4, 0.4, 0.2]);
    expect(r.data).toMatchObject({ paneId: "pan-a", gutter: { pane: "pan-a", edge: "right" } });
  });

  it("all:true makes every area on that axis equal", async () => {
    const r = await execute("pane.equalize", { pane: "pan-a", edge: "right", all: true }, {});
    expect(r.ok).toBe(true);
    expect(sizesOf()).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("an edge with no seam is TARGET_NOT_FOUND", async () => {
    const r = await execute("pane.equalize", { pane: "pan-d", edge: "right" }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
  });
});

describe("nearest axis ancestor — when there are two ancestors on the same axis", () => {
  beforeEach(() => {
    useSessions.setState({ projects: [nestedRowFixture()], activeId: "t1" });
  });

  it("moves the inner row's seam — it does not leak out to the outer row", async () => {
    const r = await execute("pane.resize", { pane: "pan-e", edge: "right", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    const outer = useSessions.getState().projects[0].spaces[0].layout;
    if (outer.type !== "split") throw new Error("not a split");
    // The outer row (col | H) must be unchanged — picking the far ancestor changes it here.
    expect(outer.sizes).toEqual([0.7, 0.3]);
    const col = outer.children[0];
    if (col.type !== "split") throw new Error("not a col");
    const innerRow = col.children[0];
    if (innerRow.type !== "split") throw new Error("not an inner row");
    expect(innerRow.sizes).toEqual([0.25, 0.75]);
    expect(r.data).toMatchObject({ gutter: { pane: "pan-e", edge: "right" } });
  });

  it("the outer row's seam is addressed as the edge of a pane touching it — F's right is that spot", async () => {
    // pan-f is the last child of the inner row, so that axis has no gutter; one level up, col has a
    // different axis and is skipped; in the outer row the col subtree is not last, so that gutter is taken.
    const r = await execute("pane.resize", { pane: "pan-f", edge: "right", ratio: 0.5 }, {});
    expect(r.ok).toBe(true);
    const outer = useSessions.getState().projects[0].spaces[0].layout;
    if (outer.type !== "split") throw new Error("not a split");
    expect(outer.sizes).toEqual([0.5, 0.5]);
    // Canonical = first pane in document order touching that gutter: col (vertical) → first child →
    // inner row (same axis) → last child = pan-f.
    expect(r.data).toMatchObject({ gutter: { pane: "pan-f", edge: "right" } });
  });
});

describe("omitted = the caller context's pane", () => {
  it("omitting pane moves the active pane's seam, and the answer names that pane", async () => {
    const r = await execute("pane.resize", { edge: "bottom", ratio: 0.75 }, {});
    expect(r.ok).toBe(true);
    // Active pane = pan-b (the fixture's activePaneId).
    expect(r.data).toMatchObject({ paneId: "pan-b" });
    expect(innerSizes()).toEqual([0.75, 0.25]);
  });
});
