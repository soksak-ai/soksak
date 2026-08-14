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
import { useSessions, type Project, type Tab } from "./sessions";
import { initialSidebarLayout } from "./sidebarLayout";
import { useViewRegistry, type PluginViewProvider } from "../plugins/viewRegistry";
import { useFileViewerRegistry } from "../plugins/fileViewerRegistry";
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

function tab(tabs: Tab[], activeTabId: string): Project {
  return {
    id: "p1",
    title: "P",
    sidebarOpen: true,
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
    root: "<local-evidence>/p1",
    spaces: [
      {
        id: "c1",
        title: "1",
        layout: { type: "leaf", value: { id: "g1", tabs, activeTabId } },
        activePaneId: "g1",
      },
    ],
    activeSpaceId: "c1",
  };
}

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
  useFileViewerRegistry.setState({ viewers: {}, version: 0 });
  usePlugins.setState({ plugins: {} });
  useProjection.setState({ byProject: {} });
  useSessions.setState({ projects: [], activeId: "" });
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
    const t = tab([pluginView("v1", "termplug", "term")], "v1");
    const bound = boundViewOf(t);
    expect(bound).toMatchObject({ viewId: "v1", ownerPluginId: "termplug" });
    expect(bound?.sidebar?.left[0]).toMatchObject({ ref: "self.tree" });
  });

  it("file view: the owning fileViewer's sidebar declaration comes through (§3.1)", () => {
    useFileViewerRegistry.getState().register(
      "edplug",
      {
        id: "code",
        extensions: ["ts"],
        sidebar: {
          left: [{ ref: "self.outline", instance: "shared" }],
          right: [],
          template: "stack",
        },
      },
      { mount: () => {} },
    );
    const fileView: Tab = { id: "v2", kind: "file", title: "b.ts", path: "/a/b.ts", mode: "code" };
    const bound = boundViewOf(tab([fileView], "v2"));
    expect(bound).toMatchObject({ viewId: "v2", ownerPluginId: "edplug" });
    expect(bound?.sidebar?.left[0]).toMatchObject({ ref: "self.outline" });
  });

  it("a file view with no owning viewer → no declaration (null sidebar)", () => {
    const fileView: Tab = { id: "v3", kind: "file", title: "x.zzz", path: "/x.zzz", mode: "code" };
    const bound = boundViewOf(tab([fileView], "v3"));
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
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    const p = projectionFor("p1");
    expect(p?.left.slots[0]).toMatchObject({
      resolvedRef: "filetree.tree",
      instanceKey: "p1|filetree.tree",
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
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });
    expect(projectionFor("p1")?.left.slots[0].status).toBe("degraded");
  });

  it("a project that does not exist → null", () => {
    expect(projectionFor("nope")).toBeNull();
  });
});

describe("startProjectionTracking — one binding per space", () => {
  it("sharing one rail instance still moves the binding to the current active view", () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    const v1 = pluginView("v1", "termplug", "term");
    const v2 = pluginView("v2", "termplug", "term");
    useSessions.setState({ projects: [tab([v1, v2], "v1")], activeId: "p1" });

    const events: { projectId: string; viewId: string | null }[] = [];
    const off = onPluginEvent("projection.changed", (e) => void events.push(e));
    const stop = startProjectionTracking();
    expect(projectionFor("p1")?.binding.viewId).toBe("v1");

    // Switching the active tab inside a group = binding change (A8).
    const t = useSessions.getState().projects[0];
    useSessions.setState({
      projects: [
        {
          ...t,
          spaces: [
            {
              ...t.spaces[0],
              layout: { type: "leaf", value: { id: "g1", tabs: [v1, v2], activeTabId: "v2" } },
            },
          ],
        },
      ],
    });

    expect(projectionFor("p1")?.binding.viewId).toBe("v2");
    expect(events.some((e) => e.projectId === "p1" && e.viewId === "v2")).toBe(true);
    expect(useProjection.getState().byProject.p1.focusHistory[0]).toBe("v2");

    stop();
    off.dispose();
  });

  it("a view goes away → focusHistory is cleaned, a project goes away → state is reclaimed", () => {
    useViewRegistry.getState().register("termplug", decl("term"), provider);
    const v1 = pluginView("v1", "termplug", "term");
    const v2 = pluginView("v2", "termplug", "term");
    useSessions.setState({ projects: [tab([v1, v2], "v1")], activeId: "p1" });
    const stop = startProjectionTracking();

    const t = useSessions.getState().projects[0];
    // v2 active → back to v1 → history [v1, v2]
    useSessions.setState({
      projects: [{ ...t, spaces: [{ ...t.spaces[0], layout: { type: "leaf", value: { id: "g1", tabs: [v1, v2], activeTabId: "v2" } } }] }],
    });
    const t2 = useSessions.getState().projects[0];
    useSessions.setState({
      projects: [{ ...t2, spaces: [{ ...t2.spaces[0], layout: { type: "leaf", value: { id: "g1", tabs: [v1, v2], activeTabId: "v1" } } }] }],
    });
    expect(useProjection.getState().byProject.p1.focusHistory).toEqual(["v1", "v2"]);

    // v2 closed → removed from history (R6 material cleanup).
    const t3 = useSessions.getState().projects[0];
    useSessions.setState({
      projects: [{ ...t3, spaces: [{ ...t3.spaces[0], layout: { type: "leaf", value: { id: "g1", tabs: [v1], activeTabId: "v1" } } }] }],
    });
    expect(useProjection.getState().byProject.p1.focusHistory).toEqual(["v1"]);

    // Project closed → state reclaimed.
    useSessions.setState({ projects: [], activeId: "" });
    expect(useProjection.getState().byProject.p1).toBeUndefined();
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
    useSessions.setState({ projects: [tab([pluginView("v1", "termplug", "term")], "v1")], activeId: "p1" });

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
    expect(events.some((e) => e.projectId === "p1" && e.viewId === "v1")).toBe(true);

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
    const t: Project = {
      ...tab([], ""),
      spaces: [
        {
          id: "c1",
          title: "1",
          activePaneId: "g1",
          layout: {
            type: "split",
            id: "s1",
            dir: "row",
            sizes: [0.5, 0.5],
            children: [
              { type: "leaf", value: { id: "g1", tabs: [vA, vC], activeTabId: "vA" } },
              { type: "leaf", value: { id: "g2", tabs: [vB], activeTabId: "vB" } },
            ],
          },
        },
      ],
    };
    useSessions.setState({ projects: [t], activeId: "p1" });
    const stop = startProjectionTracking();

    // Build binding history: A → B → A (active group switch).
    const setActive = (gid: string) => {
      const cur = useSessions.getState().projects[0];
      useSessions.setState({
        projects: [{ ...cur, spaces: [{ ...cur.spaces[0], activePaneId: gid }] }],
      });
    };
    setActive("pan-bbbbbb"); // bind B
    setActive("pan-aaaaaa"); // bind A
    expect(useProjection.getState().byProject["pjt-aaaaaa"].focusHistory.slice(0, 2)).toEqual(["vA", "vB"]);

    const r = useSessions.getState().closeView("p1", "vA");
    expect(r.ok).toBe(true);
    const content = useSessions.getState().projects[0].spaces[0];
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
    useSessions.setState({ projects: [tab([vA, vB], "vA")], activeId: "p1" });
    const stop = startProjectionTracking();
    expect(projectionFor("p1")?.left.slots[0]?.resolvedRef).toBe("kanplug.tree");

    // Active tab switch = feature switch → binding and slots replaced.
    const t = useSessions.getState().projects[0];
    useSessions.setState({
      projects: [{ ...t, spaces: [{ ...t.spaces[0], layout: { type: "leaf", value: { id: "g1", tabs: [vA, vB], activeTabId: "vB" } } }] }],
    });
    expect(projectionFor("p1")?.left.slots[0]?.resolvedRef).toBe("runplug.list");
    stop();
  });
});
