import { describe, it, expect } from "vitest";
import { serializeWorkspace, deserializeWorkspace } from "./windowSnapshot";
import type { Workspace, PaneNode, Tab } from "./sessions";

// Serialization round-trip — the PaneNode serializeSplitTree path. ids preserved, only split ids regenerated,
// live status excluded. The invariant: structure, order, sizes, active, and view parameters are preserved. A terminal is a plugin view too.


const leafOf = (n: PaneNode, i: number) => {
  const s = n as Extract<PaneNode, { type: "split" }>;
  const c = s.children[i] as Extract<PaneNode, { type: "leaf" }>;
  return c.value;
};

const workspace: Workspace = {
  id: "wsp-aaaaaa",
  title: "proj",
  root: "/repo",
  sidebarOpen: true,
  leftRailPlacement: { mode: "pin", station: 60 },
  rightOpen: false,
  sidebarLayouts: { left: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } }, right: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } } },
  activeSpaceId: "spc-aaaaaa",
  spaces: [
    {
      id: "spc-aaaaaa",
      title: "build",
      activePaneId: "pan-bbbbbb",
      railBindingTabId: "tab-aaaaaa",
      layout: {
        type: "split",
        id: "spl-gaaaaa",
        dir: "row",
        sizes: [0.6, 0.4],
        children: [
          {
            type: "leaf",
            value: {
              id: "pan-aaaaaa",
              activeTabId: "tab-aaaaaa",
              tabs: [
                {
                  id: "tab-aaaaaa",
                  kind: "plugin",
                  title: "T",
                  pluginId: "soksak-plugin-terminal-xterm",
                  view: "content",
                  command: "claude", // auto-run command (excluded from persistence — not re-run on restore)
                },
              ],
            },
          },
          {
            type: "leaf",
            value: {
              id: "pan-bbbbbb",
              activeTabId: "tab-cccccc",
              tabs: [
                { id: "tab-bbbbbb", kind: "plugin", title: "a.ts", pluginId: "plg-editor", view: "content" },
                { id: "tab-cccccc", kind: "plugin", title: "B", pluginId: "soksak-plugin-browser-native", view: "content" },
                { id: "tab-dddddd", kind: "plugin", title: "ERD", pluginId: "soksak-plugin-erd", view: "studio" },
              ],
            },
          },
        ],
      },
    },
  ],
};

describe("windowSnapshot round trip", () => {
  it("preserves structure, sizes, active and view params and every id, and does not persist the terminal command", () => {
    const snap = serializeWorkspace(workspace);
    // Every id is stored, the split node included (NAMING N2a).
    expect(JSON.stringify(snap)).toContain("spl-gaaaaa");
    // command (auto-run) is not persisted (A6: a restored terminal does not re-run).
    expect(JSON.stringify(snap)).not.toContain("claude");

    const back = deserializeWorkspace(snap);
    expect(back.root).toBe("/repo");
    expect(back.title).toBe("proj");
    expect(back.sidebarOpen).toBe(true);
    expect(back.leftRailPlacement).toEqual({ mode: "pin", station: 60 });
    expect(back.activeSpaceId).toBe("spc-aaaaaa");

    const c = back.spaces[0];
    expect(c.id).toBe("spc-aaaaaa");
    expect(c.title).toBe("build");
    expect(c.activePaneId).toBe("pan-bbbbbb");
    expect(c.railBindingTabId).toBe("tab-aaaaaa");

    const gl = c.layout as Extract<PaneNode, { type: "split" }>;
    expect(gl.dir).toBe("row");
    expect(gl.sizes).toEqual([0.6, 0.4]);
    expect(gl.id).toBe("spl-gaaaaa");

    const g1 = leafOf(c.layout, 0);
    expect(g1.id).toBe("pan-aaaaaa");
    expect(g1.activeTabId).toBe("tab-aaaaaa");
    const term = g1.tabs[0] as Extract<Tab, { kind: "plugin" }>;
    expect(term.kind).toBe("plugin");
    expect(term.pluginId).toBe("soksak-plugin-terminal-xterm");
    expect(term.view).toBe("content");
    // A restored terminal has no command (prevents automatic re-run).
    expect(term.command).toBeUndefined();

    const g2 = leafOf(c.layout, 1);
    expect(g2.tabs.map((v) => v.kind)).toEqual(["plugin", "plugin", "plugin"]);
    const file = g2.tabs[0] as Extract<Tab, { kind: "plugin" }>;
    expect(file.pluginId).toBe("plg-editor");
    expect(file.view).toBe("content");
    const webview = g2.tabs[1] as Extract<Tab, { kind: "plugin" }>;
    expect(webview.pluginId).toBe("soksak-plugin-browser-native");
    expect(webview.view).toBe("content");
    const plug = g2.tabs[2] as Extract<Tab, { kind: "plugin" }>;
    expect(plug.pluginId).toBe("soksak-plugin-erd");
    expect(plug.view).toBe("studio");
  });

  it("live status is excluded from serialization", () => {
    const p2: Workspace = {
      ...workspace,
      spaces: [
        {
          id: "spc-aaaaaa",
          title: "1",
          activePaneId: "pan-aaaaaa",
          layout: {
            type: "leaf",
            value: {
              id: "pan-aaaaaa",
              activeTabId: "tab-aaaaaa",
              tabs: [
                {
                  id: "tab-aaaaaa",
                  kind: "plugin",
                  title: "T",
                  pluginId: "soksak-plugin-terminal-xterm",
                  view: "content",
                  status: { code: "busy", message: "playing" },
                },
              ],
            },
          },
        },
      ],
    };
    const snap = serializeWorkspace(p2);
    expect(JSON.stringify(snap)).not.toContain("busy");
    const back = deserializeWorkspace(snap);
    const g = (back.spaces[0].layout as Extract<PaneNode, { type: "leaf" }>).value;
    expect(g.tabs[0].status).toBeUndefined();
  });
});

describe("left rail FLOW/PIN persistence", () => {
  it("round-trips the position PIN independently from projection ref pins", () => {
    const snap = serializeWorkspace(workspace);
    expect(snap.leftRailPlacement).toEqual({ mode: "pin", station: 60 });

    const back = deserializeWorkspace(snap);
    expect(back.leftRailPlacement).toEqual({ mode: "pin", station: 60 });
  });

  it("a pin leftover from the retired era is reverted to the default (flow) by one normalization", () => {
    // While rail migration was withdrawn, serialization wrote pin@0 even for a workspace with no placement set
    // (the default at that time). Trusting such a snapshot leaves the restored workspace anchored forever and the
    // rail does not follow focus — the feature looks silently dead. A snapshot without the marker drops the
    // stored placement once (the same one-shot migration as vlNormalized).
    const legacy = serializeWorkspace({
      ...workspace,
      leftRailPlacement: { mode: "pin", station: 0 },
    });
    delete legacy.railPlacementNormalized;
    expect(deserializeWorkspace(legacy).leftRailPlacement).toEqual({
      mode: "flow",
    });
  });

  it("with the marker present the PIN the user chose is kept as is (one-time guarantee)", () => {
    const marked = serializeWorkspace({
      ...workspace,
      leftRailPlacement: { mode: "pin", station: 60 },
    });
    expect(marked.railPlacementNormalized).toBe(true);
    expect(deserializeWorkspace(marked).leftRailPlacement).toEqual({
      mode: "pin",
      station: 60,
    });
  });

  it("a snapshot with no placement field restores to the default (flow)", () => {
    const legacy = serializeWorkspace({
      ...workspace,
      leftRailPlacement: { mode: "pin", station: 0 },
    });
    delete legacy.leftRailPlacement;
    expect(deserializeWorkspace(legacy).leftRailPlacement).toEqual({
      mode: "flow",
    });
  });
});

describe("B3 — cwd/lastActivity persistence round trip", () => {
  it("a plugin view's cwd/lastActivity survives serialize and restore (optional — omitted when absent)", () => {
    const tab: Workspace = {
      ...workspace,
      spaces: [
        {
          id: "spc-aaaaaa",
          title: "1",
          activePaneId: "pan-aaaaaa",
          layout: {
            type: "leaf",
            value: {
              id: "pan-aaaaaa",
              activeTabId: "tab-aaaaaa",
              tabs: [
                {
                  id: "tab-aaaaaa",
                  kind: "plugin",
                  title: "Terminal",
                  pluginId: "soksak-plugin-terminal-xterm",
                  view: "content",
                  cwd: "<local-evidence>/somewhere",
                  lastActivity: 1234567890,
                },
                { id: "tab-bbbbbb", kind: "plugin", title: "B", pluginId: "soksak-plugin-browser-native", view: "content" },
              ],
            },
          },
        },
      ],
    };
    const snap = serializeWorkspace(tab);
    const back = deserializeWorkspace(snap);
    const g = (back.spaces[0].layout as Extract<PaneNode, { type: "leaf" }>).value;
    const v1 = g.tabs.find((v) => v.id === "tab-aaaaaa") as Extract<Tab, { kind: "plugin" }>;
    const v2 = g.tabs.find((v) => v.id === "tab-bbbbbb") as Extract<Tab, { kind: "plugin" }>;
    expect(v1.cwd).toBe("<local-evidence>/somewhere");
    expect(v1.lastActivity).toBe(1234567890);
    expect(v2.cwd).toBeUndefined();
    expect(v2.lastActivity).toBeUndefined();
  });

  it("a plugin view's state (observed status) and customLabel (user label) survive the round trip", () => {
    const tab: Workspace = {
      ...workspace,
      spaces: [
        {
          id: "spc-aaaaaa",
          title: "1",
          activePaneId: "pan-aaaaaa",
          layout: {
            type: "leaf",
            value: {
              id: "pan-aaaaaa",
              activeTabId: "tab-aaaaaa",
              tabs: [
                {
                  id: "tab-aaaaaa",
                  kind: "plugin",
                  title: "NAVER",
                  customLabel: "My browser",
                  icon: "https://naver.com/favicon.ico",
                  pluginId: "soksak-plugin-browser-native",
                  view: "content",
                  state: { url: "https://naver.com/" },
                },
                { id: "tab-bbbbbb", kind: "plugin", title: "B", pluginId: "soksak-plugin-browser-native", view: "content" },
              ],
            },
          },
        },
      ],
    };
    const back = deserializeWorkspace(serializeWorkspace(tab));
    const g = (back.spaces[0].layout as Extract<PaneNode, { type: "leaf" }>).value;
    const v1 = g.tabs.find((v) => v.id === "tab-aaaaaa") as Extract<Tab, { kind: "plugin" }>;
    const v2 = g.tabs.find((v) => v.id === "tab-bbbbbb") as Extract<Tab, { kind: "plugin" }>;
    expect(v1.state).toEqual({ url: "https://naver.com/" });
    expect(v1.customLabel).toBe("My browser");
    expect(v1.icon).toBe("https://naver.com/favicon.ico");
    expect(v2.state).toBeUndefined();
    expect(v2.customLabel).toBeUndefined();
  });
});

describe("restore normalization — one migration per snapshot (the no-vertical-split proposition)", () => {
  // 40.6/39.5 — the 1.1 gap is outside the drag grouping rule (0.75), so new code can legitimately produce two
  // separate lines, and it is inside the legacy healing range (1.5), so an old snapshot without the marker snaps.
  const g = (id: string): PaneNode => ({
    type: "leaf",
    value: { id, activeTabId: "", tabs: [] },
  });
  const torn: Workspace = {
    ...workspace,
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        activePaneId: "g-a",
        layout: {
          type: "split",
          id: "col",
          dir: "col",
          sizes: [0.5, 0.5],
          children: [
            {
              type: "split",
              id: "top",
              dir: "row",
              sizes: [0.406, 0.594],
              children: [g("g-a"), g("g-b")],
            },
            {
              type: "split",
              id: "bot",
              dir: "row",
              sizes: [0.395, 0.605],
              children: [g("g-c"), g("g-d")],
            },
          ],
        },
      },
    ],
  };
  const rowXs = async (tab: Workspace): Promise<number[]> => {
    const { computeSplitLayout } = await import("../lib/splitLayout");
    return computeSplitLayout(tab.spaces[0].layout)
      .gutters.filter((d) => d.dir === "row")
      .sort((a, b) => a.rect.top - b.rect.top)
      .map((d) => d.rect.left);
  };

  it("an old snapshot with no marker is healed once, and re-serialization stamps the marker", async () => {
    const legacy = serializeWorkspace(torn);
    delete legacy.vlNormalized; // simulate an old snapshot from before the marker
    const back = deserializeWorkspace(legacy);
    const xs = await rowXs(back);
    expect(xs).toHaveLength(2);
    for (const x of xs) expect(x).toBeCloseTo(40.6, 10);
    // Re-serializing the healed state records the marker — every later restore is transform-free.
    expect(serializeWorkspace(back).vlNormalized).toBe(true);
  });

  it("a snapshot with the marker preserves a gap outside the drag rule (0.75~1.5) — restore is isomorphic", async () => {
    const snap = serializeWorkspace(torn);
    expect(snap.vlNormalized).toBe(true); // serialization always records the marker
    const back = deserializeWorkspace(snap);
    const xs = await rowXs(back);
    expect(xs[0]).toBeCloseTo(40.6, 10);
    expect(xs[1]).toBeCloseTo(39.5, 10); // a separate line the user made — not rewritten
  });
});

