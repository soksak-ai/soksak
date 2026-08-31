// Context resolution when an empty pane (0 tabs) is active — measured repro: moving or closing every
// tab of the active pane makes activeChain return a Location with tab=undefined, and state.context
// died with INTERNAL (TypeError). Contract: unresolvable answers with a structural error (TARGET_NOT_FOUND).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { allGroups, useSessions } from "../state/sessions";
import { useProgramRegistry } from "../plugins/programRegistry";
import type { ContributedProgram } from "../plugins/spec";

// Minimal program for verifying tab.open — the test environment has no plugin loader, so register it directly.
useProgramRegistry
  .getState()
  .register("test-plugin", {
    id: "terminal",
    kind: "view",
    view: "term",
    title: { en: "Terminal", ko: "터미널" },
  } as ContributedProgram);

useSessions.getState().bootstrapFirstWorkspace("/tmp/soksak-emptypanel");
registerCatalog();
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().workspaces));
const pristineActive = useSessions.getState().activeId;

beforeEach(() => {
  useSessions.setState({
    workspaces: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

/** Make the active pane of the active space hold 0 tabs (repro of the measured state). */
function emptyActivePane(): void {
  const workspaces = structuredClone(useSessions.getState().workspaces);
  const workspace = workspaces.find((t) => t.id === useSessions.getState().activeId)!;
  const space =
    workspace.spaces.find((c) => c.id === workspace.activeSpaceId) ?? workspace.spaces[0];
  const panes = allGroups(space.layout);
  const g = panes.find((x) => x.id === space.activePaneId) ?? panes[0];
  g.tabs = [];
  g.activeTabId = "";
  useSessions.setState({ workspaces });
}

/** Repro of a normal chain — open one tab in the active pane (bootstrap creates no tab in the test environment). */
function openOneTab(): void {
  const s = useSessions.getState();
  const r = s.openPluginView(s.activeId, "p", "test-view", "T");
  if (!r.ok) throw new Error("openPluginView failed");
}

describe("empty pane context", () => {
  it("state.context survives and answers with the position down to the pane (no tabId)", async () => {
    emptyActivePane();
    const r = await execute("state.context", {}, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ projectId: expect.any(String), paneId: expect.any(String) });
    expect((r.data as Record<string, unknown>).tabId).toBeUndefined();
  });

  it("tab.open adds a tab to an empty pane", async () => {
    emptyActivePane();
    // What this test observes is the state change — with no renderer in this environment the mount never arrives.
    // The default (wait for the mount and answer with a usable view) stays; only here the cap is set to 0.
    const r = await execute("tab.open", { program: "terminal", mountTimeoutMs: 0 }, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ paneId: expect.any(String), tabId: expect.any(String) });
  });

  it("tab.maximize on an empty pane answers with a structural error (no tab)", async () => {
    emptyActivePane();
    const r = await execute("tab.maximize", {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TARGET_NOT_FOUND");
  });

  it("returns the full position chain in a normal state", async () => {
    openOneTab();
    const r = await execute("state.context", {}, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      projectId: expect.any(String),
      spaceId: expect.any(String),
      paneId: expect.any(String),
      tabId: expect.any(String),
    });
  });
});

describe("pane.split has no default program", () => {
  it("creates an empty pane when program is omitted — the core plants no default terminal", async () => {
    const r = await execute("pane.split", { side: "right" }, {});
    expect(r.ok).toBe(true);
    // A new pane is created (paneId) but has no tab (tabId absent = blank). The core is program-agnostic.
    expect(r.data).toMatchObject({ paneId: expect.any(String) });
    expect((r.data as Record<string, unknown>).tabId).toBeUndefined();
  });

  it("fills the pane with that tab when program is given (not blank)", async () => {
    const r = await execute("pane.split", {
      side: "right", program: "terminal", mountTimeoutMs: 0,
    }, {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      paneId: expect.any(String),
      tabId: expect.any(String),
      mounted: false,
    });
  });

  it("rejects an explicit unavailable program without creating a blank pane", async () => {
    const before = allGroups(
      useSessions.getState().workspaces[0].spaces[0].layout,
    ).map((pane) => pane.id);
    const r = await execute("pane.split", {
      side: "left", program: "terminal-not-installed", mountTimeoutMs: 0,
    }, {});
    expect(r).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    const after = allGroups(
      useSessions.getState().workspaces[0].spaces[0].layout,
    ).map((pane) => pane.id);
    expect(after).toEqual(before);
  });
});
