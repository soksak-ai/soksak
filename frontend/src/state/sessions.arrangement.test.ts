import { beforeEach, describe, expect, it } from "vitest";
import { splitLeaf, type SplitTree } from "./splitTree";
import {
  projectArrangement,
  useSessions,
  type Project,
  type Pane,
} from "./sessions";

const group = (id: string): Pane => ({
  id,
  activeTabId: `v-${id}`,
  tabs: [
    {
      id: `v-${id}`,
      kind: "plugin",
      title: id,
      pluginId: "fixture",
      view: "content",
    },
  ],
});

function projectFixture(): Project {
  useSessions.getState().bootstrapFirstProject("/test/root");
  const base = useSessions.getState().projects[0];
  const db = group("db");
  const design = group("design");
  const ghostty = group("ghostty");
  const terminal = group("terminal");
  const kanban = group("kanban");
  const layout: SplitTree<Pane> = {
    type: "split",
    id: "root",
    dir: "row",
    sizes: [1 / 3, 1 / 3, 1 / 3],
    children: [
      splitLeaf(db),
      {
        type: "split",
        id: "middle",
        dir: "col",
        sizes: [0.5, 0.5],
        children: [
          {
            type: "split",
            id: "top",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [splitLeaf(design), splitLeaf(ghostty)],
          },
          splitLeaf(terminal),
        ],
      },
      splitLeaf(kanban),
    ],
  };
  return {
    ...base,
    leftRailPlacement: { mode: "flow" },
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: ghostty.id,
        layout,
      },
    ],
  };
}

beforeEach(() => {
  useSessions.setState({ projects: [], activeId: "" });
});

describe("session arrangement — the solution decides the display and the canonical tree stays unchanged", () => {
  it("a blocked focus (ghostty) is displayed as a swapped arrangement and the session tree stays unchanged", () => {
    // Fixture: [db | col([design | ghostty], terminal) | kanban]. The left 50 of ghostty is blocked by
    // terminal crossing it — per the user rule it swaps forward and snaps to the 33.33 line.
    const project = projectFixture();
    const canonical = project.spaces[0].layout;
    useSessions.setState({ projects: [project], activeId: project.id });

    const solved = projectArrangement(useSessions.getState().projects[0])!;
    expect(solved.swapped).toBe(true);
    expect(solved.cells.find((cell) => cell.id === "ghostty")!.rect.left).toBeCloseTo(100 / 3);
    expect(solved.cells.find((cell) => cell.id === "design")!.rect.left).toBeCloseTo(50);
    expect(solved.station).toBeCloseTo(100 / 3);
    expect(useSessions.getState().projects[0].spaces[0].layout).toBe(canonical);
  });

  it("moving focus to an unblocked cell displays the canonical arrangement unchanged", () => {
    const project = projectFixture();
    const canonical = project.spaces[0].layout;
    useSessions.setState({ projects: [project], activeId: project.id });
    useSessions.getState().setActiveGroup(project.id, "terminal");

    const solved = projectArrangement(useSessions.getState().projects[0])!;
    expect(solved.swapped).toBe(false);
    expect(solved.displayLayout).toBe(canonical);
    expect(solved.cells.find((cell) => cell.id === "design")!.rect.left).toBeCloseTo(100 / 3);
    expect(solved.cells.find((cell) => cell.id === "ghostty")!.rect.left).toBeCloseTo(50);
  });

  it("maximizing a tab is a single [sidebar|panel] plane, and restore brings the original arrangement back", () => {
    const project = projectFixture();
    const canonical = project.spaces[0].layout;
    useSessions.setState({ projects: [project], activeId: project.id });

    expect(useSessions.getState().maximizeView(project.id, "v-ghostty")).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    const maximized = useSessions.getState().projects[0];
    const solved = projectArrangement(maximized)!;
    expect(solved.cells).toEqual([
      { id: "ghostty", rect: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
    expect(solved.station).toBe(0);
    expect(maximized.sidebarOpen).toBe(true);
    expect(maximized.spaces[0].layout).toEqual(canonical);

    expect(useSessions.getState().restoreView(project.id)).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    const restored = useSessions.getState().projects[0];
    expect(restored.spaces[0].maximizedTabId).toBeUndefined();
    expect(restored.spaces[0].layout).toEqual(canonical);
  });

  it("PIN validity is decided by the clean line of the canonical split, not by the temporary maximize plane", () => {
    const project = projectFixture();
    const station = projectArrangement(project)!.cleanLines.find((line) => line > 0 && line < 100);
    expect(station).toBeTypeOf("number");
    const pinned: Project = {
      ...project,
      leftRailPlacement: { mode: "pin", station: station! },
    };
    useSessions.setState({ projects: [pinned], activeId: pinned.id });

    expect(useSessions.getState().maximizeView(pinned.id, "v-ghostty")).toEqual({
      ok: true,
      viewId: "v-ghostty",
    });
    expect(useSessions.getState().projects[0].leftRailPlacement).toEqual({
      mode: "pin",
      station,
    });
  });

  it("a closed sidebar leaves no rail to attach to — no swap happens", () => {
    const project = projectFixture();
    useSessions.setState({
      projects: [{ ...project, sidebarOpen: false }],
      activeId: project.id,
    });
    const solved = projectArrangement(useSessions.getState().projects[0])!;
    expect(solved.swapped).toBe(false);
  });
});

// Maximize means "this view fills the space", so the filling panel is the group that holds the view. If the
// projection uses the active group instead, the moment the two diverge — the moment a tab in another group is
// double-clicked — it collapses to a panel without the maximized view and nothing is drawn (measured:
// maximizedTabId=v35 (is in g3) but layout={"panel":"g5"}, 0 DOM slots, whole window blank).
describe("maximize — the filling panel is the group that holds the view", () => {
  it("a maximized view outside the active group collapses to that view's group", () => {
    const project = projectFixture();
    const content = project.spaces[0];
    // Active group is ghostty, maximize target is a view of kanban — the diverged state.
    const withMax: Project = {
      ...project,
      spaces: [{ ...content, activePaneId: "ghostty", maximizedTabId: "v-kanban" }],
    };
    useSessions.setState({ projects: [withMax], activeId: withMax.id });

    const solved = projectArrangement(useSessions.getState().projects[0])!;
    const shown = solved.cells.filter((c) => c.rect.width > 0 && c.rect.height > 0);
    expect(shown.map((c) => c.id)).toEqual(["kanban"]);
  });

  it("a maximized view inside the active group collapses to that same group", () => {
    const project = projectFixture();
    const content = project.spaces[0];
    const withMax: Project = {
      ...project,
      spaces: [{ ...content, activePaneId: "ghostty", maximizedTabId: "v-ghostty" }],
    };
    useSessions.setState({ projects: [withMax], activeId: withMax.id });

    const solved = projectArrangement(useSessions.getState().projects[0])!;
    const shown = solved.cells.filter((c) => c.rect.width > 0 && c.rect.height > 0);
    expect(shown.map((c) => c.id)).toEqual(["ghostty"]);
  });
});
