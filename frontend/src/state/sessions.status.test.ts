// sessions view.status channel (R1 report / R4 withdraw) — setViewStatus set, clear, missing view.
import { beforeEach, describe, expect, it } from "vitest";
import { allGroups, useSessions, type Tab } from "./sessions";

useSessions.getState().bootstrapFirstProject("<local-evidence>/soksak-status-test");
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().projects));
const pristineActive = useSessions.getState().activeId;

function findView(viewId: string): Tab | undefined {
  for (const t of useSessions.getState().projects)
    for (const c of t.spaces)
      for (const g of allGroups(c.layout))
        for (const v of g.tabs) if (v.id === viewId) return v;
  return undefined;
}

beforeEach(() => {
  useSessions.setState({
    projects: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

describe("setViewStatus — the view status channel (R1 report / R4 withdraw)", () => {
  it("reports on that view with status set, and withdraws with null (the field disappears)", () => {
    const r = useSessions.getState().openPluginView("t1", "p", "v", "T");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vid = r.viewId;

    const set = useSessions
      .getState()
      .setViewStatus("t1", vid, { code: "busy", message: "syncing" });
    expect(set.ok).toBe(true);
    expect(findView(vid)?.status).toEqual({ code: "busy", message: "syncing" });

    useSessions.getState().setViewStatus("t1", vid, null);
    expect(findView(vid)?.status).toBeUndefined();
  });

  it("an absent view is TARGET_NOT_FOUND (idempotent — the state is unchanged)", () => {
    const r = useSessions
      .getState()
      .setViewStatus("t1", "no-such-view", { code: "busy" });
    expect(r.ok).toBe(false);
  });
});

describe("setFileDirty — file dirty folded into status.code dirty (one legacy path)", () => {
  it("dirty true → status {code:'dirty'}, false → withdrawn (no second truth)", () => {
    const r = useSessions.getState().openPluginView("t1", "p", "v", "T");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vid = r.viewId;

    useSessions.getState().setFileDirty("t1", vid, true);
    expect(findView(vid)?.status).toEqual({ code: "dirty" });

    useSessions.getState().setFileDirty("t1", vid, false);
    expect(findView(vid)?.status).toBeUndefined();
  });
});
