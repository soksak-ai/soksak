// sessions 의 plugin View variant 계약 — openPluginView dedupe/활성화/닫기 경로.
// (close/move/drag 는 view id 제네릭이라 기존 동작 그대로 — 여기선 plugin 특화만 고정.)
import { beforeEach, describe, expect, it } from "vitest";
import { allGroups, useSessions } from "./sessions";

// 시작 상태 스냅샷(데이터만) — 각 테스트 전 복원.
const pristineTabs = JSON.parse(JSON.stringify(useSessions.getState().tabs));
const pristineActive = useSessions.getState().activeId;

function activeLayout() {
  const s = useSessions.getState();
  const t = s.tabs.find((x) => x.id === s.activeId)!;
  const c = t.contents.find((x) => x.id === t.activeContentId)!;
  return { t, c, groups: allGroups(c.layout) };
}

beforeEach(() => {
  useSessions.setState({
    tabs: JSON.parse(JSON.stringify(pristineTabs)),
    activeId: pristineActive,
  });
});

describe("openPluginView", () => {
  it("활성 그룹에 plugin 뷰 탭 생성 + 활성화", () => {
    const r = useSessions
      .getState()
      .openPluginView("t1", "soksak-memo", "panel", "메모");
    expect(r).toMatchObject({ ok: true, existing: false });
    if (!r.ok) return;
    const { c, groups } = activeLayout();
    const grp = groups.find((g) => g.id === r.groupId)!;
    expect(c.activeGroupId).toBe(r.groupId);
    expect(grp.activeViewId).toBe(r.viewId);
    const v = grp.views.find((x) => x.id === r.viewId)!;
    expect(v).toMatchObject({
      kind: "plugin",
      pluginId: "soksak-memo",
      view: "panel",
      title: "메모",
    });
  });

  it("같은 pluginId+view 재요청은 기존 탭 재사용(existing) + 활성화", () => {
    const first = useSessions
      .getState()
      .openPluginView("t1", "soksak-memo", "panel", "메모");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 다른 뷰를 활성화해 둔 뒤 재요청 → 기존 plugin 뷰로 복귀해야 한다.
    const { groups } = activeLayout();
    const other = groups[0].views.find((v) => v.id !== first.viewId)!;
    useSessions.getState().setActiveView("t1", other.id);

    const again = useSessions
      .getState()
      .openPluginView("t1", "soksak-memo", "panel", "메모");
    expect(again).toMatchObject({
      ok: true,
      existing: true,
      viewId: first.viewId,
    });
    const after = activeLayout();
    expect(after.groups.find((g) => g.id === (again as { groupId: string }).groupId)!.activeViewId).toBe(
      first.viewId,
    );
  });

  it("다른 뷰 id 면 별도 탭(dedupe 키 = pluginId+view)", () => {
    const a = useSessions
      .getState()
      .openPluginView("t1", "soksak-git-diff", "view", "디프");
    const b = useSessions
      .getState()
      .openPluginView("t1", "soksak-git-diff", "history", "이력");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.viewId).not.toBe(b.viewId);
  });

  it("없는 프로젝트는 TARGET_NOT_FOUND", () => {
    const r = useSessions
      .getState()
      .openPluginView("ghost", "soksak-memo", "panel", "메모");
    expect(r).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
  });
});

describe("closeView — plugin 뷰", () => {
  it("plugin 뷰 탭 닫기 후 그룹에서 제거", () => {
    const r = useSessions
      .getState()
      .openPluginView("t1", "soksak-memo", "panel", "메모");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const closed = useSessions.getState().closeView("t1", r.viewId);
    expect(closed.ok).toBe(true);
    const { groups } = activeLayout();
    expect(
      groups.flatMap((g) => g.views).some((v) => v.id === r.viewId),
    ).toBe(false);
  });
});
