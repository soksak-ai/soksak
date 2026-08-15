// terminalStatus bridge (M5) — command.started/finished → running status on that terminal view.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub localStorage first — settings reads shell, and addViewToGroup reads settings.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import {
  reportTerminalRunning,
  clearTerminalRunning,
} from "./terminalStatus";
import { allGroups, allViews, useSessions, type Tab } from "../state/sessions";
import { useProgramRegistry } from "../plugins/programRegistry";

useSessions.getState().bootstrapFirstWorkspace("<local-evidence>/soksak-termstatus");
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().workspaces));
const pristineActive = useSessions.getState().activeId;

// Register the terminal program (core terminal removed — addViewToGroup("terminal-xterm") opens the terminal plugin view).
useProgramRegistry.getState().register("soksak-plugin-terminal-xterm", {
  id: "terminal-xterm",
  title: "Terminal",
  kind: "view",
  view: "content",
});

function findView(viewId: string): Tab | undefined {
  for (const t of useSessions.getState().workspaces)
    for (const c of t.spaces)
      for (const v of allViews(c.layout)) if (v.id === viewId) return v;
  return undefined;
}

function activeGroupId(): string {
  const s = useSessions.getState();
  const t = s.workspaces.find((x) => x.id === s.activeId)!;
  const c = t.spaces.find((x) => x.id === t.activeSpaceId)!;
  return allGroups(c.layout)[0].id;
}

beforeEach(() => {
  useSessions.setState({
    workspaces: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

describe("terminalStatus — command.started/finished → running status", () => {
  it("reportTerminalRunning sets that terminal view to status=running with the command line, and clear removes it", () => {
    const r = useSessions
      .getState()
      .addViewToGroup("t1", "terminal-xterm", activeGroupId());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("could not create the terminal view");
    // Pane key of a plugin terminal = view.id of its content view (single key after the core terminal removal).
    const paneId = r.viewId;

    reportTerminalRunning(paneId, "npm run dev");
    expect(findView(r.viewId)?.status).toEqual({
      code: "running",
      message: "npm run dev",
    });

    clearTerminalRunning(paneId);
    expect(findView(r.viewId)?.status).toBeUndefined();
  });

  it("a pane that is not there is a no-op and does not throw", () => {
    expect(() => reportTerminalRunning("no-such-pane", "x")).not.toThrow();
    expect(() => clearTerminalRunning("no-such-pane")).not.toThrow();
  });
});
