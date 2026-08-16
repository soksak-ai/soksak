// Real projection wiring (§4) — session active chain → BoundView, real registry deps, tracking subscription.
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

import {
  boundViewOf,
  projectionFor,
  startProjectionTracking,
} from "./projectionWiring";
import { useProjection } from "./projection";
import { useSessions, type Workspace, type Tab } from "./sessions";
import { initialSidebarLayout } from "./sidebarLayout";
import { useViewRegistry, type PluginViewProvider } from "../plugins/viewRegistry";
import { usePlugins, type PluginRuntime } from "./plugins";
import { onPluginEvent } from "../plugins/hooks";
import { parseManifest, type ContributedView } from "../plugins/spec";

const provider: PluginViewProvider = { mount: () => {} };
const TREE_CONTRACT = "soksak-spec-plugin-sidebar-file-tree";

function decl(id: string, over: Partial<ContributedView> = {}): ContributedView {
  return {
    id,
    title: id,
    icon: "x",
    placements: ["content"],
    defaultPlacement: "content",
    transparent: false,
    nativeSurface: false,
    decoration: false,
    resident: false,
    ...over,
  };
}

function runtime(raw: Record<string, unknown>): PluginRuntime {
  const { manifest, validation } = parseManifest(
    {
      spec: "soksak-spec-plugin@0.0.1",
      name: "F",
      version: "0.0.1",
      description: "fixture",
      permissions: [],
      ...raw,
    },
    raw.id as string,
  );
  if (!manifest) throw new Error(validation.errors.join("; "));
  return { manifest, dir: `<local-evidence>/${manifest.id}`, source: "dev", status: "enabled" };
}

function pluginView(id: string, pluginId: string, view: string): Tab {
  return { id, kind: "plugin", title: id, pluginId, view };
}

function tab(tabs: Tab[], activeTabId: string): Workspace {
  return {
    id: "wsp-aaaaaa",
    title: "P",
    sidebarOpen: true,
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    root: "<local-evidence>/p1",
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        layout: { type: "leaf", value: { id: "pan-aaaaaa", tabs, activeTabId } },
        activePaneId: "pan-aaaaaa",
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  };
}

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
  usePlugins.setState({ plugins: {} });
  useProjection.setState({ byWorkspace: {} });
  useSessions.setState({ workspaces: [], activeId: "" });
});

describe("boundViewOf — session active chain → BoundView (A8)", () => {
  it("plugin view: the registered decl's sidebar declaration comes through", () => {
    useViewRegistry.getState().register(
      "termplug",
      decl("term", {
        sidebar: {
          left: [{ ref: "self.tree", instance: "shared" }],
          right: [],
          template: "stack",
        },
      }),
      provider,
    );
    const t = tab([pluginView("tab-aaaaaa", "termplug", "term")], "tab-aaaaaa");
    const bound = boundViewOf(t);
    expect(bound).toMatchObject({ viewId: "tab-aaaaaa", ownerPluginId: "termplug" });
    expect(bound?.sidebar?.left[0]).toMatchObject({ ref: "self.tree" });
  });


  it("a view whose plugin declares no sidebar → no declaration (null sidebar)", () => {
    const fileView: Tab = { id: "tab-cccccc", kind: "plugin", title: "x.zzz", pluginId: "plg-none", view: "content" };
    const bound = boundViewOf(tab([fileView], "tab-cccccc"));
    expect(bound?.sidebar).toBeNull();
  });
});

describe("projectionFor — real deps (contract resolution, rail check, consumes gate)", () => {
  it("a contract slot resolves live to the active implementation's rail view", () => {
    usePlugins.setState({
      plugins: {
        termplug: runtime({ id: "termplug", consumes: [{ id: TREE_CONTRACT, range: "^0.0.1" }] }),
        filetree: runtime({ id: "filetree", implements: [{ id: TREE_CONTRACT, version: "0.0.1" }] }),
      },
    });
    useViewRegistry.getState().register(
      "termplug",
      decl("term", {
        sidebar: {
          left: [{ contract: TREE_CONTRACT, range: "^0.0.1", view: "tree", instance: "shared" }],
          right: [],
          template: "stack",
        },
      }),
      provider,
    );
    useViewRegistry.getState().register(
      "filetree",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ workspaces: [tab([pluginView("tab-aaaaaa", "termplug", "term")], "tab-aaaaaa")], activeId: "wsp-aaaaaa" });
    const p = projectionFor("wsp-aaaaaa");
    expect(p?.left.slots[0]).toMatchObject({
      resolvedRef: "filetree.tree",
      instanceKey: "wsp-aaaaaa|filetree.tree",
      status: "live",
    });
  });

  it("with consumes undeclared the same setup is degraded (contract-pin gate)", () => {
    usePlugins.setState({
      plugins: {
        termplug: runtime({ id: "termplug" }),
        filetree: runtime({ id: "filetree", implements: [{ id: TREE_CONTRACT, version: "0.0.1" }] }),
      },
    });
    useViewRegistry.getState().register(
      "termplug",
      decl("term", {
        sidebar: {
          left: [{ contract: TREE_CONTRACT, range: "^0.0.1", view: "tree", instance: "shared" }],
          right: [],
          template: "stack",
        },
      }),
      provider,
    );
    useViewRegistry.getState().register(
      "filetree",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    useSessions.setState({ workspaces: [tab([pluginView("tab-aaaaaa", "termplug", "term")], "tab-aaaaaa")], activeId: "wsp-aaaaaa" });
    expect(projectionFor("wsp-aaaaaa")?.left.slots[0].status).toBe("degraded");
  });

  it("a workspace that does not exist → null", () => {
    expect(projectionFor("nope")).toBeNull();
  });
});

describe("startProjectionTracking — one binding per space", () => {
  it("sharing one rail instance still moves the binding to the current active view", () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    const v1 = pluginView("tab-aaaaaa", "termplug", "term");
    const v2 = pluginView("tab-bbbbbb", "termplug", "term");
    useSessions.setState({ workspaces: [tab([v1, v2], "tab-aaaaaa")], activeId: "wsp-aaaaaa" });

    const events: { projectId: string; viewId: string | null }[] = [];
    const off = onPluginEvent("projection.changed", (e) => void events.push(e));
    const stop = startProjectionTracking();
    expect(projectionFor("wsp-aaaaaa")?.binding.viewId).toBe("tab-aaaaaa");

    // Switching the active tab inside a group = binding change (A8).
    const t = useSessions.getState().workspaces[0];
    useSessions.setState({
      workspaces: [
        {
          ...t,
          spaces: [
            {
              ...t.spaces[0],
              layout: { type: "leaf", value: { id: "pan-aaaaaa", tabs: [v1, v2], activeTabId: "tab-bbbbbb" } },
            },
          ],
        },
      ],
    });

    expect(projectionFor("wsp-aaaaaa")?.binding.viewId).toBe("tab-bbbbbb");
    expect(events.some((e) => e.projectId === "wsp-aaaaaa" && e.viewId === "tab-bbbbbb")).toBe(true);
    expect(useProjection.getState().byWorkspace["wsp-aaaaaa"].focusHistory[0]).toBe("tab-bbbbbb");

    stop();
    off.dispose();
  });

  it("a view goes away → focusHistory is cleaned, a workspace goes away → state is reclaimed", () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    const v1 = pluginView("tab-aaaaaa", "termplug", "term");
    const v2 = pluginView("tab-bbbbbb", "termplug", "term");
    useSessions.setState({ workspaces: [tab([v1, v2], "tab-aaaaaa")], activeId: "wsp-aaaaaa" });
    const stop = startProjectionTracking();

    const t = useSessions.getState().workspaces[0];
    // v2 active → back to v1 → history [v1, v2]
    useSessions.setState({
      workspaces: [{ ...t, spaces: [{ ...t.spaces[0], layout: { type: "leaf", value: { id: "pan-aaaaaa", tabs: [v1, v2], activeTabId: "tab-bbbbbb" } } }] }],
    });
    const t2 = useSessions.getState().workspaces[0];
    useSessions.setState({
      workspaces: [{ ...t2, spaces: [{ ...t2.spaces[0], layout: { type: "leaf", value: { id: "pan-aaaaaa", tabs: [v1, v2], activeTabId: "tab-aaaaaa" } } }] }],
    });
    expect(useProjection.getState().byWorkspace["wsp-aaaaaa"].focusHistory).toEqual(["tab-aaaaaa", "tab-bbbbbb"]);

    // v2 closed → removed from history (R6 material cleanup).
    const t3 = useSessions.getState().workspaces[0];
    useSessions.setState({
      workspaces: [{ ...t3, spaces: [{ ...t3.spaces[0], layout: { type: "leaf", value: { id: "pan-aaaaaa", tabs: [v1], activeTabId: "tab-aaaaaa" } } }] }],
    });
    expect(useProjection.getState().byWorkspace["wsp-aaaaaa"].focusHistory).toEqual(["tab-aaaaaa"]);

    // Workspace closed → state reclaimed.
    useSessions.setState({ workspaces: [], activeId: "" });
    expect(useProjection.getState().byWorkspace.p1).toBeUndefined();
    stop();
  });
});


describe("projection.changed fingerprint firing (§4.3) — slot resolution change, silent at boot", () => {
  it("fires on a slot degraded→live transition under an unchanged binding, and the first sync (boot) is silent", () => {
    // Terminal: self-ref declaration — the target rail view is not registered yet (degraded).
    useViewRegistry.getState().register(
      "termplug",
      decl("term", {
        sidebar: {
          left: [{ ref: "self.tree", instance: "shared" }],
          right: [],
          template: "stack",
        },
      }),
      provider,
    );
    useSessions.setState({ workspaces: [tab([pluginView("tab-aaaaaa", "termplug", "term")], "tab-aaaaaa")], activeId: "wsp-aaaaaa" });

    const events: { projectId: string; viewId: string | null }[] = [];
    const off = onPluginEvent("projection.changed", (e) => void events.push(e));
    const stop = startProjectionTracking();
    expect(events).toEqual([]); // a boot observation does not fire (never replay a restore)

    // Register the rail target → the slot goes degraded→live under the same binding — must fire.
    useViewRegistry.getState().register(
      "termplug",
      decl("tree", { placements: ["rail"], defaultPlacement: "rail" }),
      provider,
    );
    expect(events.some((e) => e.projectId === "wsp-aaaaaa" && e.viewId === "tab-aaaaaa")).toBe(true);

    stop();
    off.dispose();
  });
});

describe("R6 succession — on closing the bound view, the most recent surviving view in the same space's focusHistory", () => {
  it("after the order A(g1)→B(g2)→A, closing A binds B rather than the neighbouring tab C", () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    const vA = pluginView("vA", "termplug", "term");
    const vB = pluginView("vB", "termplug", "term");
    const vC = pluginView("vC", "termplug", "term");
    const t: Workspace = {
      ...tab([], ""),
      spaces: [
        {
          id: "spc-aaaaaa",
          title: "1",
          activePaneId: "pan-aaaaaa",
          layout: {
            type: "split",
            id: "spl-aaaaaa",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [
              { type: "leaf", value: { id: "pan-aaaaaa", tabs: [vA, vC], activeTabId: "vA" } },
              { type: "leaf", value: { id: "pan-bbbbbb", tabs: [vB], activeTabId: "vB" } },
            ],
          },
        },
      ],
    };
    useSessions.setState({ workspaces: [t], activeId: "wsp-aaaaaa" });
    const stop = startProjectionTracking();

    // Build binding history: A → B → A (active group switch).
    const setActive = (gid: string) => {
      const cur = useSessions.getState().workspaces[0];
      useSessions.setState({
        workspaces: [{ ...cur, spaces: [{ ...cur.spaces[0], activePaneId: gid }] }],
      });
    };
    setActive("pan-bbbbbb"); // bind B
    setActive("pan-aaaaaa"); // bind A
    expect(useProjection.getState().byWorkspace["wsp-aaaaaa"].focusHistory.slice(0, 2)).toEqual(["vA", "vB"]);

    const r = useSessions.getState().closeView("wsp-aaaaaa", "vA");
    expect(r.ok).toBe(true);
    const content = useSessions.getState().workspaces[0].spaces[0];
    expect(content.activePaneId).toBe("pan-bbbbbb"); // R6: most recent survivor = B(g2)
    stop();
  });
});

describe("rebinding — the active content view sets the space binding (③)", () => {
  it("activating another feature's view replaces the slots with that feature's declaration", () => {
    useViewRegistry.getState().register(
      "kanplug",
      decl("board", {
        sidebar: { left: [{ ref: "self.tree", instance: "per-view" }], right: [], template: "stack" },
      }),
      provider,
    );
    useViewRegistry.getState().register("kanplug", decl("tree", { placements: ["rail"], defaultPlacement: "rail" }), provider);
    useViewRegistry.getState().register(
      "runplug",
      decl("runbook", {
        sidebar: { left: [{ ref: "self.list", instance: "per-view" }], right: [], template: "stack" },
      }),
      provider,
    );
    useViewRegistry.getState().register("runplug", decl("list", { placements: ["rail"], defaultPlacement: "rail" }), provider);

    const vA = pluginView("vA", "kanplug", "board");
    const vB = pluginView("vB", "runplug", "runbook");
    useSessions.setState({ workspaces: [tab([vA, vB], "vA")], activeId: "wsp-aaaaaa" });
    const stop = startProjectionTracking();
    expect(projectionFor("wsp-aaaaaa")?.left.slots[0]?.resolvedRef).toBe("kanplug.tree");

    // Active tab switch = feature switch → binding and slots replaced.
    const t = useSessions.getState().workspaces[0];
    useSessions.setState({
      workspaces: [{ ...t, spaces: [{ ...t.spaces[0], layout: { type: "leaf", value: { id: "pan-aaaaaa", tabs: [vA, vB], activeTabId: "vB" } } }] }],
    });
    expect(projectionFor("wsp-aaaaaa")?.left.slots[0]?.resolvedRef).toBe("runplug.list");
    stop();
  });
});
