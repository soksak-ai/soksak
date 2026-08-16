// layout.apply unit — verifies the hierarchy that builds spaces/panels (first-level space,
// second-level split), skipping of uninstalled programs, and the hint ceiling. The test
// environment has no plugin loader, so a minimal program (kind:"view") is registered directly
// through useProgramRegistry.register (emptyPanelContext.test fixture style).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { useSessions } from "../state/sessions";
import { useProgramRegistry } from "../plugins/programRegistry";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import type { ContributedProgram, PluginManifest } from "../plugins/spec";

// A terminal-engine plugin is registered so a named program resolves
// through the configured engine — no specific program id is hardcoded. The test environment has no
// plugin loader, so the contract implementation is set up directly:
//   ① register the engine program in useProgramRegistry,
//   ② put an enabled plugin declaring implements into usePlugins so discovery finds it.
const XTERM = "soksak-plugin-terminal-xterm";
const XTERM_PROGRAM = "terminal-xterm";
useProgramRegistry.getState().register(XTERM, {
  id: XTERM_PROGRAM,
  kind: "view",
  view: "content",
  title: { en: "Terminal", ko: "터미널" },
} as ContributedProgram);

const terminalEnginePlugins: Record<string, PluginRuntime> = {
  [XTERM]: {
    manifest: { id: XTERM, implements: [{ id: "soksak-spec-plugin-terminal", version: "0.0.1" }] } as unknown as PluginManifest,
    dir: "",
    source: "dev",
    status: "enabled",
  },
};

useSessions.getState().bootstrapFirstWorkspace("<local-evidence>/soksak-layout-apply");
registerCatalog();

const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().workspaces));
const pristineActive = useSessions.getState().activeId;

// Browser-class programs are attached and detached per test (to verify the skip path). register
// throws on a duplicate id, so afterEach must always reclaim it.
function registerBrowser(): () => void {
  return useProgramRegistry.getState().register("test-browser-plugin", {
    id: "browser",
    kind: "view",
    view: "web",
    title: { en: "Browser", ko: "브라우저" },
  } as ContributedProgram);
}

let unregBrowser: (() => void) | null = null;

beforeEach(() => {
  useSessions.setState({
    workspaces: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
  // Restores the terminal engine (contract implementation) to enabled — recovery after a test deletes it.
  usePlugins.setState({ plugins: { ...terminalEnginePlugins } });
});

afterEach(() => {
  unregBrowser?.();
  unregBrowser = null;
});

function firstWorkspace() {
  const s = useSessions.getState();
  return s.workspaces.find((t) => t.id === s.activeId)!;
}

describe("layout.apply", () => {
  // A pane whose program is registered is built; one whose program is not is skipped by name. The
  // caller names the programs — a `dev` preset naming a terminal and a browser stood here until
  // 2026-08-16, and what a working layout looks like is not the core's view (CORE-CENSUS 9).
  it("builds a pane for each program the caller named", async () => {
    unregBrowser = registerBrowser();
    const r = await execute(
      "layout.apply",
      { spaces: [{ title: "dev", panes: [{ program: XTERM_PROGRAM }, { program: "browser", side: "right" }] }] },
      {},
    );
    expect(r.ok).toBe(true);
    const spaces = (r.data as { spaces: { title: string; panes: { program: string }[] }[] }).spaces;
    expect(spaces).toHaveLength(1);
    expect(spaces[0].title).toBe("dev");
    expect(spaces[0].panes.map((p) => p.program)).toEqual([XTERM_PROGRAM, "browser"]);
    expect((r.data as Record<string, unknown>).skipped).toBeUndefined();
  });

  it("a pane whose program is not registered is skipped, by name and with a reason", async () => {
    const r = await execute(
      "layout.apply",
      { spaces: [{ title: "dev", panes: [{ program: XTERM_PROGRAM }, { program: "browser", side: "right" }] }] },
      {},
    );
    expect(r.ok).toBe(true);
    const data = r.data as {
      spaces: { panes: { program: string }[] }[];
      skipped?: { program: string; reason: string }[];
    };
    expect(data.spaces[0].panes.map((p) => p.program)).toEqual([XTERM_PROGRAM]);
    expect(data.skipped).toBeDefined();
    expect(data.skipped![0].program).toBe("browser");
    expect(data.skipped![0].reason.length).toBeGreaterThan(0);
  });

  it("builds the named spaces the spaces argument declares", async () => {
    const r = await execute(
      "layout.apply",
      {
        spaces: [
          { title: "a", panes: [{ program: XTERM_PROGRAM }] },
          { title: "b", panes: [{ program: XTERM_PROGRAM }, { program: XTERM_PROGRAM, side: "bottom" }] },
        ],
      },
      {},
    );
    expect(r.ok).toBe(true);
    const spaces = (r.data as { spaces: { title: string; panes: unknown[] }[] }).spaces;
    expect(spaces.map((s) => s.title)).toEqual(["a", "b"]);
    expect(spaces[0].panes).toHaveLength(1);
    expect(spaces[1].panes).toHaveLength(2);
    // Second-level panels get distinct panel ids (created by splitting).
    const b = spaces[1].panes as { paneId: string }[];
    expect(b[0].paneId).not.toBe(b[1].paneId);
  });

  it("a missing spaces argument answers INVALID_PARAMS", async () => {
    const r = await execute("layout.apply", {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_PARAMS");
  });

  it("does not destroy the existing spaces — it adds a new one", async () => {
    const before = firstWorkspace().spaces.length; // one space from boot
    const beforeId = firstWorkspace().spaces[0].id;
    const r = await execute(
      "layout.apply",
      { spaces: [{ title: "dev", panes: [{ program: XTERM_PROGRAM }, { program: "browser", side: "right" }] }] },
      {},
    );
    expect(r.ok).toBe(true);
    const after = firstWorkspace().spaces;
    expect(after.length).toBe(before + 1);
    // The original space remains untouched.
    expect(after.some((c) => c.id === beforeId)).toBe(true);
  });

  it("hint stays at 3 or fewer, and a success adds a suggestion", async () => {
    unregBrowser = registerBrowser();
    const r = await execute(
      "layout.apply",
      { spaces: [{ title: "dev", panes: [{ program: XTERM_PROGRAM }, { program: "browser", side: "right" }] }] },
      {},
    );
    expect(r.ok).toBe(true);
    expect(r.hint).toBeDefined();
    expect(r.hint!.length).toBeGreaterThan(0);
    expect(r.hint!.length).toBeLessThanOrEqual(3);
    // Suggests the move that switches to the first space (rendered with the real spaceId).
    const first = (r.data as { spaces: { spaceId: string }[] }).spaces[0].spaceId;
    expect(r.hint!.some((h) => h.cmd === `sok space.activate ${first}`)).toBe(true);
  });

  it("a skipped panel puts the install hint first", async () => {
    const r = await execute(
      "layout.apply",
      { spaces: [{ title: "dev", panes: [{ program: XTERM_PROGRAM }, { program: "browser", side: "right" }] }] },
      {},
    );
    expect(r.ok).toBe(true);
    expect(r.hint!.length).toBeLessThanOrEqual(3);
    expect(r.hint!.some((h) => h.cmd === "sok plugin.catalog")).toBe(true);
  });
});
