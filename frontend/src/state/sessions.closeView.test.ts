import { describe, it, expect, beforeEach } from "vitest";
import { useSessions } from "./sessions";
import { splitLeaf, leavesOf } from "./splitTree";

// Regression: after reload the content is left with an empty tab (empty group); adding a view by split
// and closing it makes removeView drop every group with views.length===0, so the closed view's group
// and the original empty group both vanish and tree=null. If closeView lets that path fall through
// `if(!tree) return s`, r stays at the initial noProject and reports a false "no project" error though the project is intact.
beforeEach(() => {
  useSessions.setState({ projects: [], activeId: "" });
});

describe("closeView — one side of the split is an empty tab", () => {
  it("closing the view split against an empty group keeps an empty tab, not a false no-project", () => {
    // First project created by bootstrap, content = splitLeaf(empty group) — empty tab (bare skeleton)
    useSessions.getState().bootstrapFirstProject("/test/root");
    const base = useSessions.getState().projects.find((x) => x.id === "t1")!;
    const content = base.spaces[0];
    const emptyGroup = leavesOf(content.layout)[0]; // { tabs:[], activeTabId:"" }

    // Build content.layout directly as split(empty group, one-view group) — same shape as a real split.
    const view = {
      id: "v99",
      kind: "plugin" as const,
      title: "T",
      pluginId: "p",
      view: "content",
    };
    const viewGroup = { id: "g99", tabs: [view], activeTabId: "v99" };
    const layout = {
      type: "split" as const,
      id: "s1",
      dir: "row" as const,
      sizes: [0.5, 0.5],
      children: [splitLeaf(emptyGroup), splitLeaf(viewGroup)],
    };
    useSessions.setState({
      projects: [
        { ...base, spaces: [{ ...content, layout, activePaneId: "g99" }] },
      ],
    });

    // Closing the new view empties content entirely and tree=null — it must stay an empty tab, project intact.
    const r = useSessions.getState().closeView("t1", "v99");
    expect(r.ok).toBe(true);

    // Project and content remain (empty tab = a valid skeleton state).
    const after = useSessions.getState().projects.find((x) => x.id === "t1");
    expect(after).toBeTruthy();
    expect(after!.spaces.length).toBe(1);
  });
});
