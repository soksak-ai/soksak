// terminalStatus 브리지(M5) — command.started/finished → 그 터미널 뷰의 running status.
import { beforeEach, describe, expect, it, vi } from "vitest";

// settings(addViewToGroup 가 shell 참조) localStorage stub 을 먼저.
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
import { allGroups, allViews, useSessions, type View } from "../state/sessions";

useSessions.getState().bootstrapFirstProject("/tmp/soksak-termstatus");
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().tabs));
const pristineActive = useSessions.getState().activeId;

function findView(viewId: string): View | undefined {
  for (const t of useSessions.getState().tabs)
    for (const c of t.contents)
      for (const v of allViews(c.layout)) if (v.id === viewId) return v;
  return undefined;
}

function activeGroupId(): string {
  const s = useSessions.getState();
  const t = s.tabs.find((x) => x.id === s.activeId)!;
  const c = t.contents.find((x) => x.id === t.activeContentId)!;
  return allGroups(c.layout)[0].id;
}

beforeEach(() => {
  useSessions.setState({
    tabs: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

describe("terminalStatus — command.started/finished → running status", () => {
  it("reportTerminalRunning → 그 터미널 뷰 status=running(명령라인), clear 로 회수", () => {
    const r = useSessions
      .getState()
      .addViewToGroup("t1", "terminal", activeGroupId());
    expect(r.ok).toBe(true);
    if (!r.ok || !r.paneId) throw new Error("터미널 뷰 생성 실패");

    reportTerminalRunning(r.paneId, "npm run dev");
    expect(findView(r.viewId)?.status).toEqual({
      code: "running",
      message: "npm run dev",
    });

    clearTerminalRunning(r.paneId);
    expect(findView(r.viewId)?.status).toBeUndefined();
  });

  it("없는 pane 은 no-op(throw 안 함)", () => {
    expect(() => reportTerminalRunning("no-such-pane", "x")).not.toThrow();
    expect(() => clearTerminalRunning("no-such-pane")).not.toThrow();
  });
});
