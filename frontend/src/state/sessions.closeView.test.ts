import { describe, it, expect, beforeEach } from "vitest";
import { useSessions } from "./sessions";
import { rowPlane } from "../test/planes";

// Regression: after reload the content is left with an empty tab (empty group); adding a view by split
// and closing it makes removeView drop every group with views.length===0, so the closed view's group
// and the original empty group both vanish and tree=null. If closeView lets that path fall through
// `if(!tree) return s`, r stays at the initial noWorkspace and reports a false "no workspace" error though the workspace is intact.
beforeEach(() => {
  useSessions.setState({ workspaces: [], activeId: "" });
});

describe("closeView — one side of the split is an empty tab", () => {
  it("closing the view split against an empty group keeps an empty tab, not a false no-workspace", () => {
    // First workspace created by bootstrap, content = splitLeaf(empty group) — empty tab (bare skeleton)
    useSessions.getState().bootstrapFirstWorkspace("/test/root");
    const base = useSessions.getState().workspaces[0]!;
    const content = base.spaces[0];
    const emptyGroup = content.panes[0]; // { tabs:[], activeTabId:"" }

    // Build the space directly as [empty group | one-view group] — same shape as a real split.
    const view = {
      id: "tab-yyyyyy",
      kind: "plugin" as const,
      title: "T",
      pluginId: "p",
      view: "content",
    };
    const viewGroup = { id: "pan-yyyyyy", tabs: [view], activeTabId: "tab-yyyyyy" };
    useSessions.setState({
      workspaces: [
        { ...base, spaces: [{
          ...content,
          panes: [emptyGroup, viewGroup],
          layout: rowPlane([emptyGroup.id, viewGroup.id]),
          activePaneId: "pan-yyyyyy",
        }] },
      ],
    });

    // Closing the new view leaves the empty group alone on the plane — an empty tab, workspace intact.
    const r = useSessions.getState().closeView(base.id, "tab-yyyyyy");
    expect(r.ok).toBe(true);

    // Workspace and content remain (empty tab = a valid skeleton state).
    const after = useSessions.getState().workspaces.find((x) => x.id === base.id);
    expect(after).toBeTruthy();
    expect(after!.spaces.length).toBe(1);
    expect(after!.spaces[0].panes.map((g) => g.id)).toEqual([emptyGroup.id]);
    expect(after!.spaces[0].activePaneId).toBe(emptyGroup.id);
  });
});
