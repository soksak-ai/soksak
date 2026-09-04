import { describe, it, expect } from "vitest";
import { serializeWorkspace, deserializeWorkspace } from "./windowSnapshot";
import { readableWindowSnapshot } from "./windowSnapshotShape";
import type { Workspace, Tab } from "./sessions";
import { moveBoundary, singlePane, standRail } from "./panePlane";
import { FIXTURE_BOX, rowPlane } from "../test/planes";

// Serialization round-trip — a space's panes and the plane they stand on. Every id is preserved,
// live status excluded. The invariant: the plane, order, sizes, active, and view parameters are
// preserved. A terminal is a plugin view too.

/** a | rail | b at 0.6 : 0.4 before the rail took its 100. */
const plane = standRail(moveBoundary(rowPlane(["pan-aaaaaa", "pan-bbbbbb"]), FIXTURE_BOX, "x", 1, 0.6)!, FIXTURE_BOX, 1, 100)!;

const workspace: Workspace = {
  id: "wsp-aaaaaa",
  title: "proj",
  root: "/repo",
  regionOpen: { left: false, rail: true, right: false },
  railPlacement: { mode: "pin" },
  sidebarLayouts: { left: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } }, rail: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } }, right: { type: "leaf", value: { viewKeys: [], activeViewKey: "" } } },
  activeSpaceId: "spc-aaaaaa",
  spaces: [
    {
      id: "spc-aaaaaa",
      title: "build",
      activePaneId: "pan-bbbbbb",
      panes: [
        {
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
        {
          id: "pan-bbbbbb",
          activeTabId: "tab-cccccc",
          tabs: [
            { id: "tab-bbbbbb", kind: "plugin", title: "a.ts", pluginId: "plg-editor", view: "content" },
            { id: "tab-cccccc", kind: "plugin", title: "B", pluginId: "soksak-plugin-browser-fixture", view: "content" },
            { id: "tab-dddddd", kind: "plugin", title: "ERD", pluginId: "soksak-plugin-erd", view: "studio" },
          ],
        },
      ],
      layout: plane,
    },
  ],
};

const onePane = (tabs: Tab[]): Workspace => ({
  ...workspace,
  spaces: [
    {
      id: "spc-aaaaaa",
      title: "1",
      activePaneId: "pan-aaaaaa",
      panes: [{ id: "pan-aaaaaa", activeTabId: "tab-aaaaaa", tabs }],
      layout: singlePane("pan-aaaaaa"),
    },
  ],
});

describe("windowSnapshot round trip", () => {
  it("preserves the plane, active and view params and every id, and does not persist the terminal command", () => {
    const snap = serializeWorkspace(workspace);
    // command (auto-run) is not persisted (A6: a restored terminal does not re-run).
    expect(JSON.stringify(snap)).not.toContain("claude");
    // The plane is stored as the library states it, the rail's slot and width included.
    expect(snap.contents[0].plane).toEqual(plane);

    const back = deserializeWorkspace(snap);
    expect(back.root).toBe("/repo");
    expect(back.title).toBe("proj");
    // Every place, not one of them: `left` meant the rail until the window grew three places, and
    // an assertion naming a single place would have kept passing while the other two were dropped.
    expect(back.regionOpen).toEqual({ left: false, rail: true, right: false });
    expect(back.railPlacement).toEqual({ mode: "pin" });
    expect(back.activeSpaceId).toBe("spc-aaaaaa");

    const c = back.spaces[0];
    expect(c.id).toBe("spc-aaaaaa");
    expect(c.title).toBe("build");
    expect(c.activePaneId).toBe("pan-bbbbbb");
    expect(c.layout).toEqual(plane);

    const g1 = c.panes[0];
    expect(g1.id).toBe("pan-aaaaaa");
    expect(g1.activeTabId).toBe("tab-aaaaaa");
    const term = g1.tabs[0] as Extract<Tab, { kind: "plugin" }>;
    expect(term.kind).toBe("plugin");
    expect(term.pluginId).toBe("soksak-plugin-terminal-xterm");
    expect(term.view).toBe("content");
    // A restored terminal has no command (prevents automatic re-run).
    expect(term.command).toBeUndefined();

    const g2 = c.panes[1];
    expect(g2.tabs.map((v) => v.kind)).toEqual(["plugin", "plugin", "plugin"]);
    const file = g2.tabs[0] as Extract<Tab, { kind: "plugin" }>;
    expect(file.pluginId).toBe("plg-editor");
    expect(file.view).toBe("content");
    const webview = g2.tabs[1] as Extract<Tab, { kind: "plugin" }>;
    expect(webview.pluginId).toBe("soksak-plugin-browser-fixture");
    expect(webview.view).toBe("content");
    const plug = g2.tabs[2] as Extract<Tab, { kind: "plugin" }>;
    expect(plug.pluginId).toBe("soksak-plugin-erd");
    expect(plug.view).toBe("studio");
  });

  it("live status is excluded from serialization", () => {
    const p2 = onePane([
      {
        id: "tab-aaaaaa",
        kind: "plugin",
        title: "T",
        pluginId: "soksak-plugin-terminal-xterm",
        view: "content",
        status: { code: "busy", message: "playing" },
      },
    ]);
    const snap = serializeWorkspace(p2);
    expect(JSON.stringify(snap)).not.toContain("busy");
    const back = deserializeWorkspace(snap);
    expect(back.spaces[0].panes[0].tabs[0].status).toBeUndefined();
  });
});

describe("left rail FLOW/PIN persistence", () => {
  it("round-trips the placement mode; where the rail stands is in the plane", () => {
    const snap = serializeWorkspace(workspace);
    expect(snap.railPlacement).toEqual({ mode: "pin" });
    const back = deserializeWorkspace(snap);
    expect(back.railPlacement).toEqual({ mode: "pin" });
    expect(back.spaces[0].layout.cards.find((c) => c.id === "rail")).toMatchObject({ c0: 1, c1: 2, width: 100, fixed: true });
  });

  it("writes flow for a workspace with no placement set", () => {
    const { railPlacement: _placement, ...bare } = workspace;
    void _placement;
    expect(serializeWorkspace(bare).railPlacement).toEqual({ mode: "flow" });
  });
});

// A record of another shape is refused by name, never mended (RESTORE R1, AGENTS §4-3).
describe("what this build refuses to read", () => {
  const stored = () => ({
    activeId: "wsp-aaaaaa",
    workspaces: [serializeWorkspace(workspace)],
  });

  it("reads what it writes", () => {
    expect(readableWindowSnapshot(stored())).toMatchObject({ ok: true });
  });

  // A placement is presentation: one of another shape costs that field only (RESTORE R1).
  it("a pinned station from before the plane costs the placement, and the rail follows focus", () => {
    const record = stored();
    (record.workspaces[0] as { railPlacement: unknown }).railPlacement = { mode: "pin", station: 60 };
    expect(readableWindowSnapshot(record)).toMatchObject({ ok: true });
    expect(deserializeWorkspace(record.workspaces[0]).railPlacement).toEqual({ mode: "flow" });
  });

  it("refuses a space with a split tree and no plane", () => {
    const record = stored();
    const space = record.workspaces[0].contents[0] as unknown as Record<string, unknown>;
    delete space.plane;
    space.layout = { t: "l", v: { id: "pan-aaaaaa", views: [], activeViewId: "" } };
    expect(readableWindowSnapshot(record)).toMatchObject({ ok: false, why: expect.stringContaining("no plane") });
  });

  it("refuses a plane the library cannot read", () => {
    const record = stored();
    (record.workspaces[0].contents[0] as { plane: unknown }).plane = { xs: [0, 1], ys: [0, 1], cards: [{ id: "pan-aaaaaa", c0: 0, c1: 5, r0: 0, r1: 1 }] };
    expect(readableWindowSnapshot(record)).toMatchObject({ ok: false, why: expect.stringContaining("cannot read") });
  });

  it("refuses a space whose panes and plane do not name the same ids", () => {
    const record = stored();
    (record.workspaces[0].contents[0] as { groups: unknown[] }).groups.pop();
    expect(readableWindowSnapshot(record)).toMatchObject({ ok: false, why: expect.stringContaining("places") });
  });
});

describe("B3 — cwd/lastActivity persistence round trip", () => {
  it("a plugin view's cwd/lastActivity survives serialize and restore (optional — omitted when absent)", () => {
    const tab = onePane([
      {
        id: "tab-aaaaaa",
        kind: "plugin",
        title: "Terminal",
        pluginId: "soksak-plugin-terminal-xterm",
        view: "content",
        cwd: "/tmp/somewhere",
        lastActivity: 1234567890,
      },
      { id: "tab-bbbbbb", kind: "plugin", title: "B", pluginId: "soksak-plugin-browser-fixture", view: "content" },
    ]);
    const snap = serializeWorkspace(tab);
    const back = deserializeWorkspace(snap);
    const g = back.spaces[0].panes[0];
    const v1 = g.tabs.find((v) => v.id === "tab-aaaaaa") as Extract<Tab, { kind: "plugin" }>;
    const v2 = g.tabs.find((v) => v.id === "tab-bbbbbb") as Extract<Tab, { kind: "plugin" }>;
    expect(v1.cwd).toBe("/tmp/somewhere");
    expect(v1.lastActivity).toBe(1234567890);
    expect(v2.cwd).toBeUndefined();
    expect(v2.lastActivity).toBeUndefined();
  });

  it("a plugin view's state (observed status) and customLabel (user label) survive the round trip", () => {
    const tab = onePane([
      {
        id: "tab-aaaaaa",
        kind: "plugin",
        title: "NAVER",
        customLabel: "My browser",
        icon: "https://naver.com/favicon.ico",
        pluginId: "soksak-plugin-browser-fixture",
        view: "content",
        state: { url: "https://naver.com/" },
      },
      { id: "tab-bbbbbb", kind: "plugin", title: "B", pluginId: "soksak-plugin-browser-fixture", view: "content" },
    ]);
    const back = deserializeWorkspace(serializeWorkspace(tab));
    const g = back.spaces[0].panes[0];
    const v1 = g.tabs.find((v) => v.id === "tab-aaaaaa") as Extract<Tab, { kind: "plugin" }>;
    const v2 = g.tabs.find((v) => v.id === "tab-bbbbbb") as Extract<Tab, { kind: "plugin" }>;
    expect(v1.state).toEqual({ url: "https://naver.com/" });
    expect(v1.customLabel).toBe("My browser");
    expect(v1.icon).toBe("https://naver.com/favicon.ico");
    expect(v2.state).toBeUndefined();
    expect(v2.customLabel).toBeUndefined();
  });
});
