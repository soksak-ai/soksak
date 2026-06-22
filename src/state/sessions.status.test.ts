// sessions view.status 채널(R1 보고 / R4 회수) — setViewStatus set·clear·미존재 뷰.
import { beforeEach, describe, expect, it } from "vitest";
import { allGroups, useSessions, type View } from "./sessions";

useSessions.getState().bootstrapFirstProject("/tmp/soksak-status-test");
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().tabs));
const pristineActive = useSessions.getState().activeId;

function findView(viewId: string): View | undefined {
  for (const t of useSessions.getState().tabs)
    for (const c of t.contents)
      for (const g of allGroups(c.layout))
        for (const v of g.views) if (v.id === viewId) return v;
  return undefined;
}

beforeEach(() => {
  useSessions.setState({
    tabs: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

describe("setViewStatus — 뷰 status 채널(R1 보고 / R4 회수)", () => {
  it("status set 으로 그 뷰에 보고, null 로 회수(필드 소멸)", () => {
    const r = useSessions.getState().openPluginView("t1", "p", "v", "T");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vid = r.viewId;

    const set = useSessions
      .getState()
      .setViewStatus("t1", vid, { code: "busy", message: "동기화 중" });
    expect(set.ok).toBe(true);
    expect(findView(vid)?.status).toEqual({ code: "busy", message: "동기화 중" });

    useSessions.getState().setViewStatus("t1", vid, null);
    expect(findView(vid)?.status).toBeUndefined();
  });

  it("없는 뷰는 TARGET_NOT_FOUND(멱등 — 상태 불변)", () => {
    const r = useSessions
      .getState()
      .setViewStatus("t1", "no-such-view", { code: "busy" });
    expect(r.ok).toBe(false);
  });
});

describe("setFileDirty — file dirty 를 status.code dirty 로 통합(레거시 단일화)", () => {
  it("dirty true → status {code:'dirty'}, false → 회수(이중진실 없음)", () => {
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
