// Resize addressed by gutter — the runtime proof of the invariant that no layout-tree internal
// node id appears on the command surface (IDENTITY §4 · paneInvariant ③).
//
// Rule: every gutter coincides with some pane's right/bottom edge, so pane.resize and
// pane.equalize address a gutter as (pane, edge). The operation is complete without any word for
// an internal node.
//   ① (pane, right) = the line of the plane the pane's right edge stands on.
//   ② left/top are aliases of the same line (the name used from the pane beside it) — the reply
//      echoes the canonical form (the first pane in reading order whose right/bottom stands on it).
//   ③ One gutter moves the two slots that meet on it only. The remaining lines are unchanged.
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
import { useSessions, type Workspace, type Pane } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { moveBoundary, splitPane, type PlaneState } from "../state/panePlane";
import { FIXTURE_BOX, rowPlane } from "../test/planes";

const pane = (id: string): Pane => ({ id, tabs: [], activeTabId: "" });

const close = (values: number[], expected: number[]) => {
  expect(values).toHaveLength(expected.length);
  values.forEach((v, i) => expect(v, `line ${i}`).toBeCloseTo(expected[i], 9));
};

/** [ A | B over C | D ] at 0.5 : 0.3 : 0.2, B over C at 0.6 : 0.4. */
function fixturePlane(): PlaneState {
  const row = moveBoundary(rowPlane(["pan-a", "pan-b", "pan-d"]), FIXTURE_BOX, "x", 2, 0.6)!;
  const stacked = splitPane(row, FIXTURE_BOX, "pan-b", "bottom", "pan-c")!;
  return moveBoundary(stacked, FIXTURE_BOX, "y", 1, 0.6)!;
}

function fixture(): Workspace {
  return {
    id: "wsp-aaaaaa",
    title: "P",
    root: "/tmp/pane-gutter",
    regionOpen: { left: false, rail: false, right: false },
    sidebarLayouts: { left: initialSidebarLayout([]), rail: initialSidebarLayout([]), right: initialSidebarLayout([]) },
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        panes: ["pan-a", "pan-b", "pan-c", "pan-d"].map(pane),
        layout: fixturePlane(),
        activePaneId: "pan-b",
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  };
}

/** [ E | F over G | H ] at 0.7 : 0.3, E | F at 0.4 : 0.6 of their column — the line between E and
 *  F is crossed by G, and the line between F and H is the one G ends on too. */
function nestedRowFixture(): Workspace {
  const base = fixture();
  const row = moveBoundary(rowPlane(["pan-e", "pan-h"]), FIXTURE_BOX, "x", 1, 0.7)!;
  const stacked = splitPane(row, FIXTURE_BOX, "pan-e", "bottom", "pan-g")!;
  const layout = moveBoundary(splitPane(stacked, FIXTURE_BOX, "pan-e", "right", "pan-f")!, FIXTURE_BOX, "x", 1, 0.4)!;
  return {
    ...base,
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: "pan-e",
        panes: ["pan-e", "pan-f", "pan-g", "pan-h"].map(pane),
        layout,
      },
    ],
  };
}

registerCatalog();

beforeEach(() => {
  useSessions.setState({ workspaces: [fixture()], activeId: "wsp-aaaaaa" });
});

const xs = (): number[] => useSessions.getState().workspaces[0].spaces[0].layout.xs;
const ys = (): number[] => useSessions.getState().workspaces[0].spaces[0].layout.ys;

describe("pane.resize — a seam is addressed as a pane edge", () => {
  it("① the first pane's right seam is the line its edge stands on — only two slots move and the rest stay unchanged", async () => {
    const r = await execute("pane.resize", { pane: "pan-a", edge: "right", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    // The two slots that meet on the line (0.5+0.3=0.8) become 0.25 : 0.75 — the third slot (0.2) is untouched.
    close(xs(), [0, 0.2, 0.8, 1]);
    expect(r.data).toMatchObject({
      paneId: "pan-a",
      gutter: { pane: "pan-a", edge: "right" },
    });
    close((r.data as { sizes: number[] }).sizes, [0.25, 0.75]);
  });

  it("② a stacked pane's right is the line both stacked panes end on — the canonical pane is the first in reading order", async () => {
    const r = await execute("pane.resize", { pane: "pan-b", edge: "right", ratio: 0.5 }, {});
    expect(r.ok).toBe(true);
    close(xs(), [0, 0.5, 0.75, 1]);
    expect(r.data).toMatchObject({ paneId: "pan-b", gutter: { pane: "pan-b", edge: "right" } });
  });

  it("② left is an alias for the same seam — it answers with the canonical pane and gives the ratio to the calling pane's side", async () => {
    const r = await execute("pane.resize", { pane: "pan-d", edge: "left", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    // pan-d is the slot after the line. Its sum with the slot before, 0.5, becomes 0.375 : 0.125 = 0.25 for pan-d.
    close(xs(), [0, 0.5, 0.875, 1]);
    // Canonical is the first pane in reading order whose right edge stands on that line: pan-b,
    // above pan-c.
    expect(r.data).toMatchObject({
      paneId: "pan-d",
      gutter: { pane: "pan-b", edge: "right" },
    });
  });

  it("③ bottom is the seam on the other axis — one pane has a different seam per axis", async () => {
    const r = await execute("pane.resize", { pane: "pan-b", edge: "bottom", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    close(ys(), [0, 0.25, 1]);
    close(xs(), [0, 0.5, 0.8, 1]); // the vertical lines are unchanged
    expect(r.data).toMatchObject({ gutter: { pane: "pan-b", edge: "bottom" } });
  });

  it("④ TARGET_NOT_FOUND when that edge has no seam — no other seam is guessed and moved", async () => {
    const before = xs();
    const r = await execute("pane.resize", { pane: "pan-d", edge: "right", ratio: 0.5 }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
    expect(xs()).toEqual(before);
  });

  it("ratio must be between 0 and 1 — a boundary value removes an area", async () => {
    for (const ratio of [0, 1, -0.5, 1.5]) {
      const r = await execute("pane.resize", { pane: "pan-a", edge: "right", ratio }, {});
      expect(r.ok).toBe(false);
      expect(r.code).toBe("INVALID_PARAMS");
    }
  });

  it("the answer has no line index — a name that shifts is not handed out", async () => {
    const r = await execute("pane.resize", { pane: "pan-a", edge: "right", ratio: 0.4 }, {});
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/"line"|"axis"|splitId/);
  });
});

describe("pane.equalize — equalize around a seam", () => {
  it("the default halves the two slots that seam divides — the rest stay unchanged", async () => {
    const r = await execute("pane.equalize", { pane: "pan-a", edge: "right" }, {});
    expect(r.ok).toBe(true);
    close(xs(), [0, 0.4, 0.8, 1]);
    expect(r.data).toMatchObject({ paneId: "pan-a", gutter: { pane: "pan-a", edge: "right" } });
    close((r.data as { sizes: number[] }).sizes, [0.5, 0.5]);
  });

  it("all:true makes every slot on that axis equal", async () => {
    const r = await execute("pane.equalize", { pane: "pan-a", edge: "right", all: true }, {});
    expect(r.ok).toBe(true);
    close(xs(), [0, 1 / 3, 2 / 3, 1]);
  });

  it("an edge with no seam is TARGET_NOT_FOUND", async () => {
    const r = await execute("pane.equalize", { pane: "pan-d", edge: "right" }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
  });
});

describe("a line another pane crosses — the seam is the pane's own line, not the one past it", () => {
  beforeEach(() => {
    useSessions.setState({ workspaces: [nestedRowFixture()], activeId: "wsp-aaaaaa" });
  });

  it("moves E's own line — the line F and G end on does not move", async () => {
    const r = await execute("pane.resize", { pane: "pan-e", edge: "right", ratio: 0.25 }, {});
    expect(r.ok).toBe(true);
    close(xs(), [0, 0.175, 0.7, 1]);
    expect(r.data).toMatchObject({ gutter: { pane: "pan-e", edge: "right" } });
  });

  it("the line G ends on is addressed as the edge of the first pane in reading order standing on it — F's right", async () => {
    const r = await execute("pane.resize", { pane: "pan-f", edge: "right", ratio: 0.5 }, {});
    expect(r.ok).toBe(true);
    // Halfway between E's line (0.28) and the border: 0.64.
    close(xs(), [0, 0.28, 0.64, 1]);
    expect(r.data).toMatchObject({ gutter: { pane: "pan-f", edge: "right" } });
    // G's right names the same line, and the answer is the canonical form.
    const g = await execute("pane.resize", { pane: "pan-g", edge: "right", ratio: 0.5 }, {});
    expect(g.data).toMatchObject({ gutter: { pane: "pan-f", edge: "right" } });
  });
});

describe("omitted = the caller context's pane", () => {
  it("omitting pane moves the active pane's seam, and the answer names that pane", async () => {
    const r = await execute("pane.resize", { edge: "bottom", ratio: 0.75 }, {});
    expect(r.ok).toBe(true);
    // Active pane = pan-b (the fixture's activePaneId).
    expect(r.data).toMatchObject({ paneId: "pan-b" });
    close(ys(), [0, 0.75, 1]);
  });
});
