import { describe, expect, it } from "vitest";
import { SplitPane } from "split-pane";
import { initialSidebarLayout, moveSidebarView } from "./sidebarLayout";
import { splitAtGroup, type Pane } from "./sessions";
import { serializeWorkspace, deserializeWorkspace } from "./windowSnapshot";

const pane = (id: string): Pane => ({ id, tabs: [], activeTabId: "" });
const content = (id: string) => ({ id, title: id, layout: { xs: [0, 1], ys: [0, 1], cards: [{ id, c0: 0, c1: 1, r0: 0, r1: 1, data: pane(id) }] }, activePaneId: id });

describe("canonical split-pane layout", () => {
  it("keeps structural operations in SplitPaneState", () => {
    const initial = { xs: [0, 1], ys: [0, 1], cards: [{ id: "a", c0: 0, c1: 1, r0: 0, r1: 1, data: pane("a") }] };
    const split = splitAtGroup(initial, "a", "right", pane("b"));
    expect(split.cards.map((card) => card.id)).toEqual(["a", "b"]);
    const grid = new SplitPane(split, { width: 1000, height: 700, minSize: 96 });
    expect(grid.lines("x")).toHaveLength(3);
    expect(grid.close("b")).toBe(true);
    expect(grid.toJSON().cards.map((card) => card.id)).toEqual(["a"]);
  });

  it("uses the same card contract for sidebar movement", () => {
    const initial = initialSidebarLayout(["one", "two"]);
    const next = moveSidebarView(initial, "two", { type: "split", targetKey: "one", dir: "row", before: false });
    expect(next.cards).toHaveLength(2);
    expect(next.cards.flatMap((card) => card.data.viewKeys).sort()).toEqual(["one", "two"]);
  });

  it("persists and restores canonical content and sidebar cards", () => {
    const workspace = {
      id: "workspace",
      title: "Workspace",
      root: "/workspace",
      regionOpen: { left: false, rail: true, right: false },
      railPlacement: { mode: "flow" as const },
      sidebarLayouts: { left: initialSidebarLayout(["files"]), rail: initialSidebarLayout(["outline"]), right: initialSidebarLayout([]) },
      spaces: [content("space")],
      activeSpaceId: "space",
    };
    const restored = deserializeWorkspace(serializeWorkspace(workspace));
    expect(restored.spaces[0].layout.cards.map((card) => card.id)).toEqual(["space"]);
    expect(restored.sidebarLayouts.rail.cards[0].data.viewKeys).toEqual(["outline"]);
  });
});
