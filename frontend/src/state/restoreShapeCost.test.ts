import { describe, expect, it } from "vitest";
import { restoreWindow } from "./windowPersistence";
import type { WindowSnapshot } from "./windowPersistence";
import { initialSidebarLayout } from "./sidebarLayout";

const snapshot = (): WindowSnapshot => ({
  activeId: "workspace",
  workspaces: [{
    id: "workspace",
    title: "Workspace",
    root: "/workspace",
    regionOpen: { left: false, rail: true, right: false },
    railPlacement: { mode: "flow" },
    sidebarLayouts: {
      left: initialSidebarLayout([]),
      rail: initialSidebarLayout(["outline"]),
      right: initialSidebarLayout([]),
    },
    activeContentId: "space",
    contents: [{
      id: "space",
      title: "Space",
      activeGroupId: "pane",
      layout: {
        xs: [0, 1],
        ys: [0, 1],
        cards: [{
          id: "pane-card",
          c0: 0,
          c1: 1,
          r0: 0,
          r1: 1,
          data: { id: "pane", activeViewId: "", views: [] },
        }],
      },
    }],
  }],
});

describe("canonical split-pane snapshot restoration", () => {
  it("restores workspace, content cards, and sidebar cards", () => {
    const restored = restoreWindow(snapshot());
    expect(restored.activeId).toBe("workspace");
    expect(restored.workspaces[0]?.spaces[0]?.layout.cards[0]?.data.id).toBe("pane");
    expect(restored.workspaces[0]?.sidebarLayouts.rail.cards[0]?.data.viewKeys).toEqual(["outline"]);
  });

  it("rejects a snapshot that does not satisfy the split-pane contract", () => {
    const invalid = snapshot();
    invalid.workspaces[0]!.contents[0]!.layout.xs = [0];
    expect(() => restoreWindow(invalid)).toThrow("split-pane: xs needs at least two lines");
  });
});
