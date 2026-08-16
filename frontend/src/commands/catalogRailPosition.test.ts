// Public surface for left rail position. Rail position is workspace state, but a client must
// observe and control it through state.tree and commands without reading store internals.
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
import { splitLeaf } from "../state/splitTree";
import {
  __resetLayoutSettlementForTest,
  layoutSettlementFacts,
} from "../lib/layoutSettlement";

const group = (id: string, viewId?: string): Pane => ({
  id,
  tabs: viewId
    ? [{
        id: viewId,
        kind: "plugin",
        title: id,
        pluginId: "test.plugin",
        view: "main",
      }]
    : [],
  activeTabId: viewId ?? "",
});

function workspace(
  placement?: Workspace["leftRailPlacement"],
): Workspace {
  return {
    id: "wsp-aaaaaa",
    title: "P",
    root: "<local-evidence>/rail-position",
    sidebarOpen: true,
    ...(placement ? { leftRailPlacement: placement } : {}),
    rightOpen: false,
    sidebarLayouts: { left: initialSidebarLayout([]), right: initialSidebarLayout([]) },
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        layout: {
          type: "split",
          id: "spl-aaaaaa",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", value: group("pan-aaaaaa") },
            { type: "leaf", value: group("pan-bbbbbb") },
          ],
        },
        activePaneId: "pan-bbbbbb",
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  };
}

/** Layout whose per-row vertical lines do not align — terminal crosses ghostty's left 50. */
function switchWorkspace(): Workspace {
  const base = workspace({ mode: "flow" });
  return {
    ...base,
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: "ghostty",
        layout: {
          type: "split",
          id: "root",
          dir: "row",
          sizes: [1 / 3, 1 / 3, 1 / 3],
          children: [
            splitLeaf(group("db")),
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
                  children: [
                    splitLeaf(group("design")),
                    splitLeaf(group("ghostty")),
                  ],
                },
                splitLeaf(group("terminal")),
              ],
            },
            splitLeaf(group("kanban")),
          ],
        },
      },
    ],
  };
}

registerCatalog();

beforeEach(() => {
  __resetLayoutSettlementForTest();
  useSessions.setState({ workspaces: [workspace()], activeId: "wsp-aaaaaa" });
});

type Position = {
  mode: "flow" | "pin";
  station?: number;
  effectiveStation: number;
  cleanLines: number[];
};

function resultPosition(result: Awaited<ReturnType<typeof execute>>): Position {
  return (result.data as { leftRailPosition: Position }).leftRailPosition;
}

describe("sidebar.left.position", () => {
  it("an omitted call reads the current FLOW state — the rail aligns to the left line of the focused pane", async () => {
    const result = await execute("sidebar.left.position", {}, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "flow",
      effectiveStation: 50, // the left line of the active pane g2
      cleanLines: [0, 50, 100],
    });
  });

  it("PIN with no station pins the current FLOW effective line where it is", async () => {
    const result = await execute("sidebar.left.position", { mode: "pin" }, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "pin",
      station: 50,
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
    expect(useSessions.getState().workspaces[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 50,
    });
  });

  it("PIN with a station snaps to the nearest clean line and stores that", async () => {
    const result = await execute(
      "sidebar.left.position",
      { mode: "pin", station: 31 },
      {},
    );
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toMatchObject({
      mode: "pin",
      station: 50,
      effectiveStation: 50,
    });
    expect(useSessions.getState().workspaces[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 50,
    });
  });

  it("an existing dirty PIN is not silently re-saved — persisted and effective are read apart", async () => {
    useSessions.setState({
      workspaces: [workspace({ mode: "pin", station: 31 })],
      activeId: "wsp-aaaaaa",
    });

    const result = await execute("sidebar.left.position", {}, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "pin",
      station: 31,
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
    expect(useSessions.getState().workspaces[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 31,
    });
  });

  it("a FLOW command removes the pinned station and restores focus following at once", async () => {
    useSessions.setState({
      workspaces: [workspace({ mode: "pin", station: 0 })],
      activeId: "wsp-aaaaaa",
    });

    const result = await execute("sidebar.left.position", { mode: "flow" }, {});
    expect(result.ok).toBe(true);
    expect(resultPosition(result)).toEqual({
      mode: "flow",
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
    expect(useSessions.getState().workspaces[0].leftRailPlacement).toEqual({
      mode: "flow",
    });
  });

  it("PIN→FLOW with the same displayed solution opens no settlement revision, only a real station change", async () => {
    useSessions.setState({
      workspaces: [workspace({ mode: "pin", station: 50 })],
      activeId: "wsp-aaaaaa",
    });

    const unchanged = await execute("sidebar.left.position", { mode: "flow" }, {});
    expect(unchanged.ok).toBe(true);
    expect(resultPosition(unchanged)).toMatchObject({
      mode: "flow",
      effectiveStation: 50,
    });
    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({ active: false, pending: [] });

    useSessions.setState({
      workspaces: [workspace({ mode: "pin", station: 0 })],
      activeId: "wsp-aaaaaa",
    });
    const changed = await execute("sidebar.left.position", { mode: "flow" }, {});
    expect(changed.ok).toBe(true);
    expect(resultPosition(changed)).toMatchObject({
      mode: "flow",
      effectiveStation: 50,
    });
    expect(layoutSettlementFacts("wsp-aaaaaa")).toEqual({
      active: true,
      pending: [{ key: "wsp-aaaaaa", requested: 1, settled: 0 }],
    });
  });

  it("refuses a station outside the logical plane, and FLOW+station ambiguity, as structural errors", async () => {
    const outside = await execute(
      "sidebar.left.position",
      { mode: "pin", station: 101 },
      {},
    );
    expect(outside).toMatchObject({ ok: false, code: "INVALID_PARAMS" });

    const ambiguous = await execute(
      "sidebar.left.position",
      { mode: "flow", station: 50 },
      {},
    );
    expect(ambiguous).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});

describe("state.tree — the solution is a public fact", () => {
  it("exposes a pinned rail relation on the same basis for left, right and non-adjacent", async () => {
    const withBinding = workspace({ mode: "pin", station: 0 });
    withBinding.spaces[0] = {
      ...withBinding.spaces[0],
      activePaneId: "pan-bbbbbb",
      railBindingTabId: "tab-bbbbbb",
      layout: {
        type: "split",
        id: "spl-aaaaaa",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          { type: "leaf", value: group("pan-aaaaaa", "tab-aaaaaa") },
          { type: "leaf", value: group("pan-bbbbbb", "tab-bbbbbb") },
        ],
      },
    };
    useSessions.setState({ workspaces: [withBinding], activeId: "wsp-aaaaaa" });
    const detached = await execute("state.tree", {}, {});
    const relation = (detached.data as { workspaces: Array<{ spaces: Array<{ railRelation: unknown }> }> })
      .workspaces[0].spaces[0].railRelation;
    expect(relation).toEqual({
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
    const withoutLock = workspace({ mode: "pin", station: 0 });
    withoutLock.spaces[0] = {
      ...withoutLock.spaces[0],
      activePaneId: "pan-aaaaaa",
      layout: {
        type: "split",
        id: "spl-aaaaaa",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          { type: "leaf", value: group("pan-aaaaaa", "tab-aaaaaa") },
          { type: "leaf", value: group("pan-bbbbbb", "tab-bbbbbb") },
        ],
      },
    };
    useSessions.setState({ workspaces: [withoutLock], activeId: "wsp-aaaaaa" });

    const tree = await execute("state.tree", {}, {});
    const treeRelation = (tree.data as {
      workspaces: Array<{ spaces: Array<{ railRelation: unknown }> }>;
    }).workspaces[0].spaces[0].railRelation;
    const panes = await execute("pane.list", {}, {});
    const paneRelation = (panes.data as { railRelation: unknown }).railRelation;

    expect(treeRelation).toEqual({
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
    const closed = workspace({ mode: "pin", station: 0 });
    closed.sidebarOpen = false;
    closed.spaces[0] = {
      ...closed.spaces[0],
      activePaneId: "pan-aaaaaa",
      layout: {
        type: "leaf",
        value: group("pan-aaaaaa", "tab-aaaaaa"),
      },
    };
    useSessions.setState({ workspaces: [closed], activeId: "wsp-aaaaaa" });

    const tree = await execute("state.tree", {}, {});
    const relation = (tree.data as {
      workspaces: Array<{ spaces: Array<{ railRelation: unknown }> }>;
    }).workspaces[0].spaces[0].railRelation;
    expect(relation).toEqual({
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

  it("restores station, split and relation direction exactly after a two-way PIN maximize/restore", async () => {
    for (const [paneId, tabId, side] of [
      ["pan-aaaaaa", "tab-aaaaaa", "left"],
      ["pan-bbbbbb", "tab-bbbbbb", "right"],
    ] as const) {
      const pinned = workspace({ mode: "pin", station: 50 });
      pinned.spaces[0] = {
        ...pinned.spaces[0],
        activePaneId: paneId,
        layout: {
          type: "split",
          id: "spl-aaaaaa",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", value: group("pan-aaaaaa", "tab-aaaaaa") },
            { type: "leaf", value: group("pan-bbbbbb", "tab-bbbbbb") },
          ],
        },
      };
      useSessions.setState({ workspaces: [pinned], activeId: "wsp-aaaaaa" });

      const read = async () => {
        const result = await execute("state.tree", {}, {});
        return (result.data as {
          workspaces: Array<{
            leftRailPosition: Position;
            spaces: Array<{
              layout: unknown;
              canonicalLayout: unknown;
              railRelation: { side: string; relationId: string };
            }>;
          }>;
        }).workspaces[0];
      };

      const before = await read();
      expect(before.leftRailPosition).toMatchObject({
        mode: "pin",
        station: 50,
        effectiveStation: 50,
      });
      expect(before.spaces[0].railRelation.side).toBe(side);

      expect(useSessions.getState().maximizeView("wsp-aaaaaa", tabId)).toMatchObject({ ok: true });
      const maximized = await read();
      expect(maximized.spaces[0].railRelation.side).toBe(side);
      expect(maximized.leftRailPosition.station).toBe(50);

      expect(useSessions.getState().restoreView("wsp-aaaaaa")).toMatchObject({ ok: true });
      const restored = await read();
      expect(restored.leftRailPosition).toEqual(before.leftRailPosition);
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
      workspaces: [workspace({ mode: "pin", station: 31 })],
      activeId: "wsp-aaaaaa",
    });
    const result = await execute("state.tree", {}, {});
    expect(result.ok).toBe(true);
    const workspaces = (result.data as {
      workspaces: Array<{ leftRailPosition: Position }>;
    }).workspaces;
    expect(workspaces[0].leftRailPosition).toEqual({
      mode: "pin",
      station: 31,
      effectiveStation: 50,
      cleanLines: [0, 50, 100],
    });
  });

  it("exposes a row-mismatched switch in the displayed layout and panes, and reports the canonical form with it", async () => {
    const original = switchWorkspace();
    useSessions.setState({ workspaces: [original], activeId: original.id });

    const result = await execute("state.tree", {}, {});
    const space = (result.data as {
      workspaces: Array<{
        leftRailPosition: Position;
        spaces: Array<{
          layout: { children: unknown[] };
          canonicalLayout: { children: unknown[] };
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

    expect(space.leftRailPosition.effectiveStation).toBeCloseTo(100 / 3, 1);
    const first = space.spaces[0];
    expect(first.projection).toEqual({
      kind: "switched",
      applied: true,
      focusedPaneId: "ghostty",
      swappedPanes: ["design", "ghostty"],
    });
    expect(first.canonicalLayout).not.toEqual(first.layout);
    expect(first.panes.find((pane) => pane.id === "ghostty")?.rect.left).toBe(33.3);
    expect(first.panes.find((pane) => pane.id === "design")?.rect.left).toBe(50);
    // The session canonical layout never changes — only the presentation is switched.
    expect(useSessions.getState().workspaces[0].spaces[0].layout).toBe(
      original.spaces[0].layout,
    );
  });

  it("maximize exposes the public layout/panes as the real [sidebar|feature] plane too", async () => {
    const original = switchWorkspace();
    useSessions.setState({ workspaces: [original], activeId: original.id });
    // Fixture groups have no views, so set the public state directly and verify serialization only.
    useSessions.setState((s) => ({
      workspaces: s.workspaces.map((t) => ({
        ...t,
        spaces: t.spaces.map((c) => ({
          ...c,
          activePaneId: "ghostty",
          maximizedTabId: "v-max",
        })),
      })),
    }));

    const result = await execute("state.tree", {}, {});
    const space = (result.data as {
      workspaces: Array<{ spaces: Array<{
        layout: { pane: string };
        canonicalLayout: { children: unknown[] };
        projection: { kind: string; applied: boolean; focusedPaneId: string; swappedPanes: string[] };
        panes: Array<{ id: string; rect: { left: number; top: number; width: number; height: number } }>;
      }> }>;
    }).workspaces[0].spaces[0];
    expect(space.layout).toEqual({ pane: "ghostty" });
    expect(space.panes).toEqual([
      { id: "ghostty", rect: { left: 0, top: 0, width: 100, height: 100 }, active: true, activeTabId: "", tabs: [] },
    ]);
    expect(space.projection).toEqual({
      kind: "maximized",
      applied: true,
      focusedPaneId: "ghostty",
      swappedPanes: [],
    });
    expect(space.canonicalLayout.children).toHaveLength(3);
  });
});
