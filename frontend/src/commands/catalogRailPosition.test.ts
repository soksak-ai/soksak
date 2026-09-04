// Public surface for left rail position. Where the rail stands is on the space's plane, and a
// client must observe and control it through state.tree and commands without reading store
// internals.
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
import { useSectionSets } from "../state/sectionSets";
import { equalizeAxis, splitPane, standRail, type PlaneState } from "../state/panePlane";
import { planeBox, setPlaneBox } from "../state/planeBox";
import { setPlaceWidth } from "../state/placeWidth";
import { rowPlane } from "../test/planes";
import {
  __resetLayoutSettlementForTest,
  layoutSettlementFacts,
} from "../lib/layoutSettlement";

const RAIL_W = 100;

const group = (
  id: string,
  viewId: string = `${id}-view`,
  pluginId: string = "test.plugin",
): Pane => ({
  id,
  tabs: viewId
    ? [{
        id: viewId,
        kind: "plugin",
        title: id,
        pluginId,
        view: "main",
      }]
    : [],
  activeTabId: viewId ?? "",
});

/** a | b in a 1000×600 plane, the rail standing at `railLine` when given. */
function workspace(
  placement?: Workspace["railPlacement"],
  options: { panes?: Pane[]; railLine?: number | null; activePaneId?: string } = {},
): Workspace {
  const panes = options.panes ?? [group("pan-aaaaaa"), group("pan-bbbbbb")];
  const bare = rowPlane(panes.map((g) => g.id));
  const railLine = options.railLine === undefined ? 1 : options.railLine;
  return {
    id: "wsp-aaaaaa",
    title: "P",
    root: "/tmp/rail-position",
    regionOpen: { left: false, rail: true, right: false },
    ...(placement ? { railPlacement: placement } : {}),
    sidebarLayouts: { left: initialSidebarLayout([]), rail: initialSidebarLayout([]), right: initialSidebarLayout([]) },
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        panes,
        layout: railLine === null ? bare : standRail(bare, planeBox(), railLine, RAIL_W)!,
        activePaneId: options.activePaneId ?? "pan-bbbbbb",
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  };
}

/** [db | (design | ghostty) over terminal | kanban] in thirds of a 1500 plane, the rail at the
 *  front of the middle column: the line between design and ghostty is crossed by terminal. */
function switchWorkspace(): Workspace {
  const base = workspace({ mode: "flow" });
  const box = planeBox();
  const thirds = equalizeAxis(rowPlane(["db", "design", "kanban"]), box, "x");
  const stacked = splitPane(thirds, box, "design", "bottom", "terminal")!;
  const layout: PlaneState = standRail(splitPane(stacked, box, "design", "right", "ghostty")!, box, 1, RAIL_W)!;
  return {
    ...base,
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: "ghostty",
        panes: ["db", "design", "ghostty", "terminal", "kanban"].map((id) => group(id)),
        layout,
      },
    ],
  };
}

registerCatalog();

beforeEach(() => {
  setPlaneBox({ width: 1000, height: 600, gap: 0 });
  setPlaceWidth("rail", RAIL_W);
  __resetLayoutSettlementForTest();
  useSectionSets.setState({ sets: [], byPlugin: {}, left: null });
  const set = useSectionSets.getState().create("test rail");
  useSectionSets.getState().arrange(set.id, ["test.plugin.section"]);
  useSectionSets.getState().link("test.plugin", "rail", set.id);
  useSessions.setState({ workspaces: [workspace()], activeId: "wsp-aaaaaa" });
});

type Position = {
  mode: "flow" | "pin";
  effectiveStation: number;
  line: number | null;
  cleanLines: number[];
  standingLines: number[];
};

function resultPosition(result: Awaited<ReturnType<typeof execute>>): Position {
  return (result.data as { railPosition: Position }).railPosition;
}

describe("rail.position", () => {
  it("an omitted call reads where the rail stands — beside the focused pane under FLOW", async () => {
    const result = await execute("rail.position", {}, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "flow",
      effectiveStation: 500, // the left line of the active pane b
      line: 1,
      cleanLines: [0, 500, 600, 1000],
      standingLines: [0, 1, 2, 3],
    });
  });

  it("PIN with no line pins the rail where it stands", async () => {
    const result = await execute("rail.position", { mode: "pin" }, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toMatchObject({ mode: "pin", effectiveStation: 500, line: 1 });
    expect(useSessions.getState().workspaces[0].railPlacement).toEqual({ mode: "pin" });
  });

  it("PIN with a line moves the rail to that standing and pins it there", async () => {
    const result = await execute("rail.position", { mode: "pin", line: 0 }, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toMatchObject({ mode: "pin", effectiveStation: 0, line: 0 });
    expect(useSessions.getState().workspaces[0].railPlacement).toEqual({ mode: "pin" });
  });

  it("a FLOW command restores focus following at once — the rail goes back beside the focused pane", async () => {
    useSessions.setState({
      workspaces: [workspace({ mode: "pin" }, { railLine: 0 })],
      activeId: "wsp-aaaaaa",
    });

    const result = await execute("rail.position", { mode: "flow" }, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toMatchObject({ mode: "flow", line: 1 });
    // Beside the focused pane: the rail's right edge is b's left edge. The rail took its room from
    // a when it stood at the front, and a keeps what it had when the rail leaves (split-pane R5).
    const panes = (await execute("pane.list", {}, {})).data as { panes: Array<{ id: string; rect: { left: number } }> };
    expect(resultPosition(result).effectiveStation + RAIL_W)
      .toBe(panes.panes.find((p) => p.id === "pan-bbbbbb")!.rect.left);
    expect(useSessions.getState().workspaces[0].railPlacement).toEqual({ mode: "flow" });
  });

  it("PIN→FLOW with the same displayed solution opens no settlement revision, only a real station change", async () => {
    useSessions.setState({
      workspaces: [workspace({ mode: "pin" })],
      activeId: "wsp-aaaaaa",
    });

    const unchanged = await execute("rail.position", { mode: "flow" }, {});
    expect(unchanged.ok).toBe(true);
    expect(resultPosition(unchanged)).toMatchObject({ mode: "flow", effectiveStation: 500 });
    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({ active: false, pending: [] });

    useSessions.setState({
      workspaces: [workspace({ mode: "pin" }, { railLine: 0 })],
      activeId: "wsp-aaaaaa",
    });
    const changed = await execute("rail.position", { mode: "flow" }, {});
    expect(changed.ok).toBe(true);
    expect(resultPosition(changed)).toMatchObject({ mode: "flow", line: 1 });
    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({
      active: true,
      pending: [{ key: "wsp-aaaaaa", requested: 1, settled: 0 }],
    });
  });

  it("refuses a line the rail cannot stand on, and FLOW+line ambiguity, as structural errors", async () => {
    const outside = await execute("rail.position", { mode: "pin", line: 7 }, {});
    expect(outside).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    const fraction = await execute("rail.position", { mode: "pin", line: 0.5 }, {});
    expect(fraction).toMatchObject({ ok: false, code: "INVALID_PARAMS" });

    const ambiguous = await execute("rail.position", { mode: "flow", line: 1 }, {});
    expect(ambiguous).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});

describe("state.tree — the solution is a public fact", () => {
  it("exposes a pinned rail relation on the same basis for left, right and non-adjacent", async () => {
    // rail | a | b, b focused: b is not beside the rail.
    const withBinding = workspace({ mode: "pin" }, {
      panes: [group("pan-aaaaaa", "tab-aaaaaa"), group("pan-bbbbbb", "tab-bbbbbb")],
      railLine: 0,
      activePaneId: "pan-bbbbbb",
    });
    useSessions.setState({ workspaces: [withBinding], activeId: "wsp-aaaaaa" });
    const detached = await execute("state.tree", {}, {});
    const relation = (detached.data as { workspaces: Array<{ spaces: Array<{ railRelation: unknown }> }> })
      .workspaces[0].spaces[0].railRelation;
    expect(relation).toEqual({
      source: "focus",
      boundTabId: "tab-bbbbbb",
      boundPaneId: "pan-bbbbbb",
      relationId: "rail-relation/spc-aaaaaa/pan-bbbbbb/tab-bbbbbb",
      placement: "pin",
      connected: false,
      side: "detached",
      borderMode: "independent",
      pathCount: 2,
    });
  });

  it("exposes the active tab of the active pane as the effective binding with no explicit one, as the screen does", async () => {
    const withoutLock = workspace({ mode: "pin" }, {
      panes: [group("pan-aaaaaa", "tab-aaaaaa"), group("pan-bbbbbb", "tab-bbbbbb")],
      railLine: 0,
      activePaneId: "pan-aaaaaa",
    });
    useSessions.setState({ workspaces: [withoutLock], activeId: "wsp-aaaaaa" });

    const tree = await execute("state.tree", {}, {});
    const treeRelation = (tree.data as {
      workspaces: Array<{ spaces: Array<{ railRelation: unknown }> }>;
    }).workspaces[0].spaces[0].railRelation;
    const panes = await execute("pane.list", {}, {});
    const paneRelation = (panes.data as { railRelation: unknown }).railRelation;

    expect(treeRelation).toEqual({
      source: "focus",
      boundTabId: "tab-aaaaaa",
      boundPaneId: "pan-aaaaaa",
      relationId: "rail-relation/spc-aaaaaa/pan-aaaaaa/tab-aaaaaa",
      placement: "pin",
      connected: true,
      side: "right",
      borderMode: "union",
      pathCount: 1,
    });
    expect(paneRelation).toEqual(treeRelation);
  });

  it("states a none/0 state with no binding and no drawing when the sidebar is closed", async () => {
    const closed = workspace({ mode: "pin" }, {
      panes: [group("pan-aaaaaa", "tab-aaaaaa")],
      railLine: null,
      activePaneId: "pan-aaaaaa",
    });
    closed.regionOpen = { ...closed.regionOpen, rail: false };
    useSessions.setState({ workspaces: [closed], activeId: "wsp-aaaaaa" });

    const tree = await execute("state.tree", {}, {});
    const relation = (tree.data as {
      workspaces: Array<{ spaces: Array<{ railRelation: unknown }> }>;
    }).workspaces[0].spaces[0].railRelation;
    expect(relation).toEqual({
      source: "none",
      boundTabId: null,
      boundPaneId: null,
      relationId: "rail-relation/spc-aaaaaa/none",
      placement: "pin",
      connected: false,
      side: "detached",
      borderMode: "none",
      pathCount: 0,
    });
  });

  it("states none/0 when the rail preference is open but the selected tab's plugin has no linked set", async () => {
    const unlinked = workspace({ mode: "flow" }, {
      panes: [group("pan-aaaaaa", "tab-aaaaaa"), group("pan-bbbbbb", "tab-bbbbbb", "test.unlinked")],
      activePaneId: "pan-bbbbbb",
    });
    useSessions.setState({ workspaces: [unlinked], activeId: unlinked.id });

    const tree = await execute("state.tree", {}, {});
    const relation = (tree.data as {
      workspaces: Array<{ spaces: Array<{ railRelation: unknown }> }>;
    }).workspaces[0].spaces[0].railRelation;

    expect(relation).toEqual({
      source: "none",
      boundTabId: null,
      boundPaneId: null,
      relationId: "rail-relation/spc-aaaaaa/none",
      placement: "flow",
      connected: false,
      side: "detached",
      borderMode: "none",
      pathCount: 0,
    });
  });

  it("restores the rail's line, the plane and the relation direction exactly after a two-way PIN maximize/restore", async () => {
    for (const [paneId, tabId, side] of [
      ["pan-aaaaaa", "tab-aaaaaa", "left"],
      ["pan-bbbbbb", "tab-bbbbbb", "right"],
    ] as const) {
      const pinned = workspace({ mode: "pin" }, {
        panes: [group("pan-aaaaaa", "tab-aaaaaa"), group("pan-bbbbbb", "tab-bbbbbb")],
        railLine: 1,
        activePaneId: paneId,
      });
      useSessions.setState({ workspaces: [pinned], activeId: "wsp-aaaaaa" });

      const read = async () => {
        const result = await execute("state.tree", {}, {});
        return (result.data as {
          workspaces: Array<{
            railPosition: Position;
            spaces: Array<{
              layout: unknown;
              canonicalLayout: unknown;
              railRelation: { side: string; relationId: string };
            }>;
          }>;
        }).workspaces[0];
      };

      const before = await read();
      expect(before.railPosition).toMatchObject({ mode: "pin", effectiveStation: 500, line: 1 });
      expect(before.spaces[0].railRelation.side).toBe(side);

      expect(useSessions.getState().maximizeView("wsp-aaaaaa", tabId)).toMatchObject({ ok: true });
      const maximized = await read();
      expect(maximized.spaces[0].railRelation.side).toBe(side);
      expect(maximized.railPosition.line).toBe(1);

      expect(useSessions.getState().restoreView("wsp-aaaaaa")).toMatchObject({ ok: true });
      const restored = await read();
      expect(restored.railPosition).toEqual(before.railPosition);
      expect(restored.spaces[0].layout).toEqual(before.spaces[0].layout);
      expect(restored.spaces[0].canonicalLayout).toEqual(
        before.spaces[0].canonicalLayout,
      );
      expect(restored.spaces[0].railRelation).toEqual(
        before.spaces[0].railRelation,
      );
    }
  });

  it("exposes the position with the same computation as the command query", async () => {
    useSessions.setState({
      workspaces: [workspace({ mode: "pin" }, { railLine: 0 })],
      activeId: "wsp-aaaaaa",
    });
    const result = await execute("state.tree", {}, {});
    expect(result.ok).toBe(true);
    const workspaces = (result.data as {
      workspaces: Array<{ railPosition: Position }>;
    }).workspaces;
    expect(workspaces[0].railPosition).toEqual(resultPosition(await execute("rail.position", {}, {})));
    expect(workspaces[0].railPosition).toMatchObject({ mode: "pin", effectiveStation: 0, line: 0 });
  });

  it("exposes a row-mismatched switch in the displayed layout and panes, and reports the canonical form with it", async () => {
    setPlaneBox({ width: 1500, height: 800, gap: 0 });
    const original = switchWorkspace();
    useSessions.setState({ workspaces: [original], activeId: original.id });

    const result = await execute("state.tree", {}, {});
    const space = (result.data as {
      workspaces: Array<{
        railPosition: Position;
        spaces: Array<{
          layout: { cards: unknown[] };
          canonicalLayout: { cards: unknown[] };
          projection: {
            kind: string;
            applied: boolean;
            focusedPaneId: string;
            swappedPanes: string[];
          };
          panes: Array<{ id: string; rect: { left: number } }>;
        }>;
      }>;
    }).workspaces[0];

    expect(space.railPosition.effectiveStation).toBeCloseTo(500, 6);
    const first = space.spaces[0];
    expect(first.projection).toEqual({
      kind: "switched",
      applied: true,
      focusedPaneId: "ghostty",
      swappedPanes: ["design", "ghostty"],
    });
    expect(first.canonicalLayout).not.toEqual(first.layout);
    expect(first.panes.find((pane) => pane.id === "ghostty")?.rect.left).toBe(600);
    expect(first.panes.find((pane) => pane.id === "design")?.rect.left).toBeGreaterThan(600);
    // The session's plane never changes — only the presentation is switched.
    expect(useSessions.getState().workspaces[0].spaces[0].layout).toBe(
      original.spaces[0].layout,
    );
  });

  it("maximize exposes the public layout/panes as the real [sidebar|feature] plane too", async () => {
    setPlaneBox({ width: 1500, height: 800, gap: 0 });
    const original = switchWorkspace();
    useSessions.setState({ workspaces: [original], activeId: original.id });
    // Fixture groups have no views, so set the public state directly and verify serialization only.
    useSessions.setState((s) => ({
      workspaces: s.workspaces.map((t) => ({
        ...t,
        spaces: t.spaces.map((c) => ({
          ...c,
          activePaneId: "ghostty",
          maximizedTabId: "ghostty-view",
        })),
      })),
    }));

    const result = await execute("state.tree", {}, {});
    const space = (result.data as {
      workspaces: Array<{ spaces: Array<{
        layout: { cards: Array<{ id: string }> };
        canonicalLayout: { cards: unknown[] };
        projection: { kind: string; applied: boolean; focusedPaneId: string; swappedPanes: string[] };
        panes: Array<{ id: string; rect: { left: number; top: number; width: number; height: number } }>;
      }> }>;
    }).workspaces[0].spaces[0];
    expect(space.layout.cards.map((c) => c.id).sort()).toEqual(["ghostty", "rail"]);
    expect(space.panes).toMatchObject([
      {
        id: "ghostty",
        rect: { left: RAIL_W, top: 0, width: 1500 - RAIL_W, height: 800 },
        active: true,
        activeTabId: "ghostty-view",
        tabs: [{ id: "ghostty-view", plugin: "test.plugin" }],
      },
    ]);
    expect(space.projection).toEqual({
      kind: "maximized",
      applied: true,
      focusedPaneId: "ghostty",
      swappedPanes: [],
    });
    expect(space.canonicalLayout.cards).toHaveLength(6);
  });
});
