// The plugin Tab variant contract in sessions — openPluginView dedupe, activation, and close routes.
// (close/move/drag are generic over view id and keep the existing behavior — only the plugin-specific parts are pinned here.)
import { beforeEach, describe, expect, it } from "vitest";
import { allGroups, allViews, useSessions } from "./sessions";
import { useProgramRegistry } from "../plugins/programRegistry";
import { usePlugins, type PluginRuntime } from "./plugins";
import { useContractSelection } from "./contractSelection";
import { parseManifest } from "../plugins/spec";

// Boot model (P3): tabs start empty and main.tsx creates the first project through
// bootstrapFirstProject — the test prepares t1 the same way, then snapshots.
useSessions.getState().bootstrapFirstProject("<local-evidence>/soksak-test-root");

// Snapshot of the starting state (data only) — restored before each test.
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().projects));
const pristineActive = useSessions.getState().activeId;

function activeLayout() {
  const s = useSessions.getState();
  const t = s.projects.find((x) => x.id === s.activeId)!;
  const c = t.spaces.find((x) => x.id === t.activeSpaceId)!;
  return { t, c, groups: allGroups(c.layout) };
}

beforeEach(() => {
  useSessions.setState({
    projects: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

describe("openPluginView", () => {
  it("creates a plugin view tab in the active group and activates it", () => {
    const r = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-memo", "panel", "Memo");
    expect(r).toMatchObject({ ok: true, existing: false });
    if (!r.ok) return;
    const { c, groups } = activeLayout();
    const grp = groups.find((g) => g.id === r.groupId)!;
    expect(c.activePaneId).toBe(r.groupId);
    expect(grp.activeTabId).toBe(r.viewId);
    const v = grp.tabs.find((x) => x.id === r.viewId)!;
    expect(v).toMatchObject({
      kind: "plugin",
      pluginId: "soksak-plugin-memo",
      view: "panel",
      title: "Memo",
    });
  });

  it("the same pluginId+view requested again reuses the existing tab and activates it", () => {
    const first = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-memo", "panel", "Memo");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Activate another view, then request again -> it must return to the existing plugin view.
    // (Empty group model — there is no automatic first view, so open a second plugin view and leave it active.)
    const other = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-git-diff", "view", "Diff");
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.viewId).not.toBe(first.viewId);

    const again = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-memo", "panel", "Memo");
    expect(again).toMatchObject({
      ok: true,
      existing: true,
      viewId: first.viewId,
    });
    const after = activeLayout();
    expect(after.groups.find((g) => g.id === (again as { groupId: string }).groupId)!.activeTabId).toBe(
      first.viewId,
    );
  });

  it("a different view id gives a separate tab — the dedupe key is pluginId+view", () => {
    const a = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-git-diff", "view", "Diff");
    const b = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-git-diff", "history", "History");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.viewId).not.toBe(b.viewId);
  });

  it("a project that does not exist gives TARGET_NOT_FOUND", () => {
    const r = useSessions
      .getState()
      .openPluginView("ghost", "soksak-plugin-memo", "panel", "Memo");
    expect(r).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
  });
});

describe("closeView — plugin view", () => {
  it("closing a plugin view tab removes it from the group", () => {
    const r = useSessions
      .getState()
      .openPluginView("t1", "soksak-plugin-memo", "panel", "Memo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const closed = useSessions.getState().closeView("t1", r.viewId);
    expect(closed.ok).toBe(true);
    const { groups } = activeLayout();
    expect(
      groups.flatMap((g) => g.tabs).some((v) => v.id === r.viewId),
    ).toBe(false);
  });
});

// Registered program with kind=view -> the + menu and addContent open plugin view content (§2.6, plugin-agnostic).
describe("addContent — kind=view program", () => {
  it("a registered view program makes the new content's first view that plugin's view", () => {
    const dispose = useProgramRegistry.getState().register("soksak-plugin-erd", {
      id: "erd-prog-test",
      title: "ERD",
      path: "Utilities",
      kind: "view",
      view: "canvas",
    });
    try {
      const r = useSessions.getState().addContent("t1", "erd-prog-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { c, groups } = activeLayout();
      expect(c.id).toBe(r.contentId);
      const grp = groups.find((g) => g.id === r.groupId)!;
      const v = grp.tabs.find((x) => x.id === r.viewId)!;
      expect(v).toMatchObject({
        kind: "plugin",
        pluginId: "soksak-plugin-erd",
        view: "canvas",
        title: "ERD",
      });
    } finally {
      dispose();
    }
  });

  // An agent program (agent-claude) opens another plugin's view (terminal) together with an autorun command.
  // viewPlugin = the plugin that owns the view (cross-plugin reference), command = the autorun command fed into that terminal view.
  it("a cross-plugin view program with command opens the target plugin's view and passes the autorun command", () => {
    const dispose = useProgramRegistry.getState().register("soksak-plugin-agent-claude", {
      id: "claude-prog-test",
      title: "Claude",
      path: "Agents",
      kind: "view",
      view: "content",
      viewPlugin: "soksak-plugin-terminal-xterm",
      command: "claude",
      ensure: { bin: "claude", install: { darwin: "curl … | bash" } },
    });
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-prog-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { groups } = activeLayout();
      const grp = groups.find((g) => g.id === r.groupId)!;
      const v = grp.tabs.find((x) => x.id === r.viewId)!;
      expect(v).toMatchObject({
        kind: "plugin",
        pluginId: "soksak-plugin-terminal-xterm", // viewPlugin — the plugin that owns the view, not the program's own plugin
        view: "content",
        title: "Claude",
        command: "claude", // the autorun command is set on the plugin Tab
      });
    } finally {
      dispose();
    }
  });

  // With viewPlugin unset, the view is the program's own plugin view (the terminal plugin's terminal program — backward compatible).
  it("viewPlugin unset = the program's own plugin view (backward compatible)", () => {
    const dispose = useProgramRegistry.getState().register("soksak-plugin-terminal-xterm", {
      id: "terminal-prog-test",
      title: "Terminal",
      kind: "view",
      view: "content",
    });
    try {
      const r = useSessions.getState().addViewToGroup("t1", "terminal-prog-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { groups } = activeLayout();
      const grp = groups.find((g) => g.id === r.groupId)!;
      const v = grp.tabs.find((x) => x.id === r.viewId)!;
      expect(v).toMatchObject({
        kind: "plugin",
        pluginId: "soksak-plugin-terminal-xterm",
        view: "content",
      });
      expect((v as { command?: string }).command).toBeUndefined();
    } finally {
      dispose();
    }
  });
});

// Initial program of project.create — addProject takes program and creates a view in the first group.
// (Reproduces and pins the defect where, after the terminal became a plugin, the command declared
// program and dropped it, leaving an empty panel (black screen) — omitting it still yields the empty
// skeleton, as designed.)
describe("addProject — initial program", () => {
  it("with program set, the first group gets that program's view and activeViewId, and viewId is returned", () => {
    const dispose = useProgramRegistry.getState().register("soksak-plugin-terminal-xterm", {
      id: "terminal-prog-test",
      title: "Terminal",
      kind: "view",
      view: "content",
    });
    try {
      const r = useSessions.getState().addProject({
        alias: "px",
        root: "<local-evidence>/soksak-test-addproject",
        program: "terminal-prog-test",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.viewId).toBeTruthy();
      const t = useSessions.getState().projects.find((x) => x.id === r.projectId)!;
      const grp = allGroups(t.spaces[0].layout).find((g) => g.id === r.groupId)!;
      expect(grp.activeTabId).toBe(r.viewId);
      const v = grp.tabs.find((x) => x.id === r.viewId)!;
      expect(v).toMatchObject({
        kind: "plugin",
        pluginId: "soksak-plugin-terminal-xterm",
        view: "content",
        title: "Terminal",
      });
    } finally {
      dispose();
    }
  });

  it("with program omitted, an empty skeleton (0 views, no viewId) — the existing design holds", () => {
    const r = useSessions.getState().addProject({
      alias: "",
      root: "<local-evidence>/soksak-test-addproject-empty",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.viewId).toBeUndefined();
    const t = useSessions.getState().projects.find((x) => x.id === r.projectId)!;
    expect(allViews(t.spaces[0].layout)).toHaveLength(0);
  });

  it("an unregistered program degrades to an empty skeleton — makeContent creates no view", () => {
    const r = useSessions.getState().addProject({
      alias: "",
      root: "<local-evidence>/soksak-test-addproject-unreg",
      program: "no-such-program",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.viewId).toBeUndefined();
  });
});

// viewContract (contract pin C3) — when a program references a contract instead of a plugin id, the
// core discovers the active implementers (implementersOf), picks one by user setting, and opens that
// implementer's view. The core has no notion of contract meaning — zero hardcoded plugin ids
// (plugin-agnostic). The view id is the program's declared value (content by convention).
describe("addViewToGroup — viewContract (contract-pin) resolution", () => {
  const XTERM = "soksak-plugin-terminal-xterm";
  const GHOSTTY = "soksak-plugin-terminal-ghostty";
  const CONTRACT = { id: "soksak-spec-plugin-terminal", range: ">=0.0.1 <1.0.0" };

  // Fixture runtime — passes the real schema gate (parseManifest); implements is a spec-validated field.
  function fixtureRuntime(
    id: string,
    implementsIds: { id: string; version: string }[],
    status: PluginRuntime["status"] = "enabled",
  ): PluginRuntime {
    const { manifest, validation } = parseManifest(
      {
        spec: "soksak-spec-plugin@0.0.1",
        id,
        name: "Fixture",
        version: "0.0.1",
        description: "Contract fixture",
        permissions: [],
        ...(implementsIds.length > 0 ? { implements: implementsIds } : {}),
      },
      id,
    );
    if (!manifest) throw new Error(`fixture manifest invalid: ${validation.errors.join("; ")}`);
    return { manifest, dir: `<local-evidence>/${id}`, source: "dev", status };
  }

  beforeEach(() => {
    // Two engines implement the same contract while enabled (discovery order = xterm, ghostty).
    usePlugins.setState({
      plugins: {
        [XTERM]: fixtureRuntime(XTERM, [{ id: CONTRACT.id, version: "0.0.1" }]),
        [GHOSTTY]: fixtureRuntime(GHOSTTY, [{ id: CONTRACT.id, version: "0.0.1" }]),
      },
    });
    useContractSelection.setState({ selected: {} });
  });

  // Register a contract-referencing program (agent-program shape) — the view owner is discovered through viewContract, without viewPlugin.
  function registerContractProgram() {
    return useProgramRegistry.getState().register("soksak-plugin-agent-claude", {
      id: "claude-contract-test",
      title: "Claude",
      kind: "view",
      view: "content",
      viewContract: CONTRACT,
      command: "claude",
    });
  }

  function viewOf(r: { groupId: string; viewId: string }): { pluginId?: string } & Record<string, unknown> {
    const { groups } = activeLayout();
    return groups.find((g) => g.id === r.groupId)!.tabs.find((x) => x.id === r.viewId)! as unknown as {
      pluginId?: string;
    } & Record<string, unknown>;
  }

  it("no selection → the first enabled implementer (xterm) view, with view id and autorun command passed", () => {
    const dispose = registerContractProgram();
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-contract-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(viewOf(r)).toMatchObject({
        kind: "plugin",
        pluginId: XTERM, // first in discovery order — no specific id hardcoded
        view: "content",
        title: "Claude",
        command: "claude",
      });
    } finally {
      dispose();
    }
  });

  it("a user selection resolves to that implementer (ghostty) — engine choice", () => {
    const dispose = registerContractProgram();
    useContractSelection.getState().select(CONTRACT.id, GHOSTTY);
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-contract-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(viewOf(r).pluginId).toBe(GHOSTTY);
    } finally {
      dispose();
    }
  });

  it("a stale selection (not an implementer) falls back to the first item", () => {
    const dispose = registerContractProgram();
    useContractSelection.getState().select(CONTRACT.id, "soksak-plugin-not-an-impl");
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-contract-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(viewOf(r).pluginId).toBe(XTERM);
    } finally {
      dispose();
    }
  });

  it("a disabled implementer is no candidate — resolution uses enabled implementers only", () => {
    usePlugins.setState({
      plugins: {
        [XTERM]: fixtureRuntime(XTERM, [{ id: CONTRACT.id, version: "0.0.1" }], "disabled"),
        [GHOSTTY]: fixtureRuntime(GHOSTTY, [{ id: CONTRACT.id, version: "0.0.1" }]),
      },
    });
    const dispose = registerContractProgram();
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-contract-test");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(viewOf(r).pluginId).toBe(GHOSTTY);
    } finally {
      dispose();
    }
  });

  it("0 enabled implementers → no view is created (TARGET_NOT_FOUND, degrades to an empty group)", () => {
    usePlugins.setState({ plugins: {} });
    const dispose = registerContractProgram();
    try {
      const r = useSessions.getState().addViewToGroup("t1", "claude-contract-test");
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("TARGET_NOT_FOUND");
    } finally {
      dispose();
    }
  });
});
