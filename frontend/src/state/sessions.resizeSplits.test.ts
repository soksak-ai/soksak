import { beforeEach, describe, expect, it } from "vitest";
import { splitLeaf, type SplitTree } from "./splitTree";
import { computeSplitLayout } from "../lib/splitLayout";
import {
  useSessions,
  type PaneNode,
  type Workspace,
  type Pane,
} from "./sessions";

// Store boundary of the no-vertical-fragmentation rule — a companion drag persists every split on the line in
// one resizeSplits commit. No intermediate fragmented state; rail collision is checked once on the final state
// (on rejection nothing changes).

function group(id: string, viewId: string): Pane {
  return {
    id,
    activeTabId: viewId,
    tabs: [
      {
        id: viewId,
        kind: "plugin",
        title: viewId,
        pluginId: "fixture",
        view: "content",
      },
    ],
  };
}

// col[top row, bottom row] — a space whose vertical line is cut into two segments.
function stackedWorkspace(): Workspace {
  useSessions.getState().bootstrapFirstWorkspace("/test/root");
  const base = useSessions.getState().workspaces[0];
  const layout: SplitTree<Pane> = {
    type: "split",
    id: "s-stack",
    dir: "col",
    sizes: [0.5, 0.5],
    children: [
      {
        type: "split",
        id: "s-top",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [splitLeaf(group("g-tl", "v-tl")), splitLeaf(group("g-tr", "v-tr"))],
      },
      {
        type: "split",
        id: "s-bot",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [splitLeaf(group("g-bl", "v-bl")), splitLeaf(group("g-br", "v-br"))],
      },
    ],
  };
  return {
    ...base,
    spaces: [{ ...base.spaces[0], activePaneId: "g-tl", layout }],
  };
}

beforeEach(() => {
  useSessions.setState({ workspaces: [], activeId: "" });
});

describe("resizeSplits — several splits in one commit", () => {
  it("both segments of one line apply together", () => {
    const workspace = stackedWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });

    const result = useSessions.getState().resizeSplits(workspace.id, [
      { splitId: "s-top", sizes: [0.6, 0.4] },
      { splitId: "s-bot", sizes: [0.6, 0.4] },
    ]);

    expect(result).toEqual({ ok: true });
    const layout = useSessions.getState().workspaces[0].spaces[0].layout as Extract<
      PaneNode,
      { type: "split" }
    >;
    const rows = computeSplitLayout(layout).gutters.filter((d) => d.dir === "row");
    expect(rows.map((d) => d.rect.left)).toEqual([60, 60]);
  });

  it("rejects the whole batch when the final state conflicts with a PIN rail (no change)", () => {
    const workspace: Workspace = {
      ...stackedWorkspace(),
      railPlacement: { mode: "pin", station: 50 },
    };
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const before = useSessions.getState().workspaces[0];

    const result = useSessions.getState().resizeSplits(workspace.id, [
      { splitId: "s-top", sizes: [0.6, 0.4] },
      { splitId: "s-bot", sizes: [0.6, 0.4] },
    ]);

    expect(result).toMatchObject({ ok: false, code: "LAYOUT_CONFLICT" });
    expect(useSessions.getState().workspaces[0]).toBe(before);
  });

  it("answers TARGET_NOT_FOUND when any splitId is absent (no change)", () => {
    const workspace = stackedWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const before = useSessions.getState().workspaces[0];

    const result = useSessions.getState().resizeSplits(workspace.id, [
      { splitId: "s-top", sizes: [0.6, 0.4] },
      { splitId: "s-ghost", sizes: [0.6, 0.4] },
    ]);

    expect(result).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    expect(useSessions.getState().workspaces[0]).toBe(before);
  });
});
