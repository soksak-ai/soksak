// sessions view.status channel (R1 report / R4 withdraw) — setViewStatus set, clear, missing view.
import { beforeEach, describe, expect, it } from "vitest";
import { allGroups, useSessions, type Tab } from "./sessions";

useSessions.getState().bootstrapFirstWorkspace("<local-evidence>/soksak-status-test");
// The workspace identifier is issued (state/ids.ts), so it is read here rather
// than written down. A literal is a shape the product does not produce, and code
// that reads a prefix is then never run against it (NAMING N4).
const WORKSPACE = useSessions.getState().activeId;
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().workspaces));
const pristineActive = useSessions.getState().activeId;

function findView(viewId: string): Tab | undefined {
  for (const t of useSessions.getState().workspaces)
    for (const c of t.spaces)
      for (const g of allGroups(c.layout))
        for (const v of g.tabs) if (v.id === viewId) return v;
  return undefined;
}

beforeEach(() => {
  useSessions.setState({
    workspaces: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

describe("setViewStatus — the view status channel (R1 report / R4 withdraw)", () => {
  it("reports on that view with status set, and withdraws with null (the field disappears)", () => {
    const r = useSessions.getState().openPluginView(WORKSPACE, "p", "v", "T");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vid = r.viewId;

    const set = useSessions
      .getState()
      .setViewStatus(WORKSPACE, vid, { code: "busy", message: "syncing" });
    expect(set.ok).toBe(true);
    expect(findView(vid)?.status).toEqual({ code: "busy", message: "syncing" });

    useSessions.getState().setViewStatus(WORKSPACE, vid, null);
    expect(findView(vid)?.status).toBeUndefined();
  });

  it("an absent view is TARGET_NOT_FOUND (idempotent — the state is unchanged)", () => {
    const r = useSessions
      .getState()
      .setViewStatus(WORKSPACE, "no-such-view", { code: "busy" });
    expect(r.ok).toBe(false);
  });

  it("does not publish or clone state when the status value is unchanged", () => {
    const opened = useSessions.getState().openPluginView(WORKSPACE, "p", "v", "T");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    let notifications = 0;
    const stop = useSessions.subscribe(() => { notifications += 1; });

    const beforeEmpty = useSessions.getState().workspaces;
    useSessions.getState().setViewStatus(WORKSPACE, opened.viewId, null);
    expect(useSessions.getState().workspaces).toBe(beforeEmpty);
    expect(notifications).toBe(0);

    useSessions.getState().setViewStatus(WORKSPACE, opened.viewId, { code: "busy", message: "syncing" });
    expect(notifications).toBe(1);
    const beforeRepeat = useSessions.getState().workspaces;
    useSessions.getState().setViewStatus(WORKSPACE, opened.viewId, { code: "busy", message: "syncing" });
    expect(useSessions.getState().workspaces).toBe(beforeRepeat);
    expect(notifications).toBe(1);
    stop();
  });
});

describe("setFileDirty — file dirty folded into status.code dirty (one legacy path)", () => {
  it("dirty true → status {code:'dirty'}, false → withdrawn (no second truth)", () => {
    const r = useSessions.getState().openPluginView(WORKSPACE, "p", "v", "T");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vid = r.viewId;

    useSessions.getState().setFileDirty(WORKSPACE, vid, true);
    expect(findView(vid)?.status).toEqual({ code: "dirty" });

    useSessions.getState().setFileDirty(WORKSPACE, vid, false);
    expect(findView(vid)?.status).toBeUndefined();
  });
});
