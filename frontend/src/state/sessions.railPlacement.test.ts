import { beforeEach, describe, expect, it } from "vitest";
import { splitLeaf } from "./splitTree";
import { projectArrangement, useSessions, type Workspace, type Pane } from "./sessions";

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

function twoColumnWorkspace(): Workspace {
  useSessions.getState().bootstrapFirstWorkspace("/test/root");
  const base = useSessions.getState().workspaces[0];
  const left = group("g-left", "v-left");
  const right = group("g-right", "v-right");
  return {
    ...base,
    leftRailPlacement: { mode: "pin", station: 50 },
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: right.id,
        layout: {
          type: "split",
          id: "s-columns",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [splitLeaf(left), splitLeaf(right)],
        },
      },
    ],
  };
}

beforeEach(() => {
  useSessions.setState({ workspaces: [], activeId: "" });
});

describe("position PIN guards the clean grid line", () => {
  it("rejects a horizontal resize that would move the pinned line", () => {
    const workspace = twoColumnWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const before = useSessions.getState().workspaces[0];

    const result = useSessions
      .getState()
      .resizeSplit(workspace.id, "s-columns", [0.6, 0.4]);

    expect(result).toMatchObject({ ok: false, code: "LAYOUT_CONFLICT" });
    expect(useSessions.getState().workspaces[0]).toBe(before);
  });

  it("allows a focus change without moving the persisted PIN", () => {
    const workspace = twoColumnWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });

    expect(useSessions.getState().setActiveGroup(workspace.id, "g-left")).toEqual({
      ok: true,
    });
    expect(useSessions.getState().workspaces[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 50,
    });
  });

  it("allows maximize on an internal PIN by direction projection and keeps the stored station", () => {
    const workspace = twoColumnWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });

    expect(useSessions.getState().maximizeView(workspace.id, "v-right")).toEqual({
      ok: true,
      viewId: "v-right",
    });
    expect(projectArrangement(useSessions.getState().workspaces[0])!.station).toBe(0);
    expect(useSessions.getState().workspaces[0].leftRailPlacement).toEqual({ mode: "pin", station: 50 });

    expect(useSessions.getState().restoreView(workspace.id)).toEqual({ ok: true, viewId: "v-right" });
    expect(projectArrangement(useSessions.getState().workspaces[0])!.station).toBe(50);
  });

  it("rejects removing the boundary that owns the PIN", () => {
    const workspace = twoColumnWorkspace();
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const before = useSessions.getState().workspaces[0];

    const result = useSessions.getState().closeGroup(workspace.id, "g-left");

    expect(result).toMatchObject({ ok: false, code: "LAYOUT_CONFLICT" });
    expect(useSessions.getState().workspaces[0]).toBe(before);
  });
});
