// 뷰 레지스트리 계약 — 등록/해제/version 신호/배치 필터.
import { beforeEach, describe, expect, it } from "vitest";
import {
  getRegisteredView,
  useViewRegistry,
  viewsForPlacement,
  type PluginViewProvider,
} from "./viewRegistry";
import type { ContributedView } from "./spec";

const provider: PluginViewProvider = { mount: () => {} };

function decl(id: string, placements: ContributedView["placements"]): ContributedView {
  return { id, title: id, icon: "P", placements, defaultPlacement: placements[0] };
}

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
});

describe("viewRegistry", () => {
  it("등록 → 전역 키로 조회 가능 + version 증가", () => {
    const v0 = useViewRegistry.getState().version;
    useViewRegistry.getState().register("memo", decl("panel", ["sidebar-right"]), provider);
    expect(getRegisteredView("memo.panel")?.pluginId).toBe("memo");
    expect(useViewRegistry.getState().version).toBe(v0 + 1);
  });

  it("중복 등록은 거부(§0-3 침묵 충돌 금지)", () => {
    useViewRegistry.getState().register("memo", decl("panel", ["sidebar-right"]), provider);
    expect(() =>
      useViewRegistry.getState().register("memo", decl("panel", ["sidebar-right"]), provider),
    ).toThrow(/이미 등록된 뷰/);
  });

  it("해제는 멱등 + version 은 실제 변경 시에만 증가", () => {
    const remove = useViewRegistry
      .getState()
      .register("memo", decl("panel", ["sidebar-right"]), provider);
    remove();
    expect(getRegisteredView("memo.panel")).toBeNull();
    const v = useViewRegistry.getState().version;
    remove(); // 두 번째 해제 — 변화 없음
    expect(useViewRegistry.getState().version).toBe(v);
  });

  it("setViewBadge — 설정/해제, 0 정규화, version 미증가(뷰 remount 방지), 뷰 해제 시 배지 정리", () => {
    const st = useViewRegistry.getState();
    const remove = st.register("memo", decl("panel", ["sidebar-right"]), provider);
    const v = useViewRegistry.getState().version;

    st.setViewBadge("memo.panel", 3);
    expect(useViewRegistry.getState().badges["memo.panel"]).toBe(3);
    // 배지 변경은 version 을 올리지 않는다(뷰 remount 방지).
    expect(useViewRegistry.getState().version).toBe(v);

    st.setViewBadge("memo.panel", "dot");
    expect(useViewRegistry.getState().badges["memo.panel"]).toBe("dot");
    // 0 = 없음으로 정규화(키 제거).
    st.setViewBadge("memo.panel", 0);
    expect(useViewRegistry.getState().badges["memo.panel"]).toBeUndefined();

    st.setViewBadge("memo.panel", 5);
    remove(); // 뷰 해제 → 배지도 정리.
    expect(useViewRegistry.getState().badges["memo.panel"]).toBeUndefined();
  });

  it("viewsForPlacement 는 선언 배치로 필터", () => {
    useViewRegistry.getState().register("memo", decl("panel", ["sidebar-right"]), provider);
    useViewRegistry
      .getState()
      .register("diff", decl("view", ["content", "sidebar-right"]), provider);
    expect(viewsForPlacement("sidebar-right").map((x) => x.key)).toEqual([
      "memo.panel",
      "diff.view",
    ]);
    expect(viewsForPlacement("content").map((x) => x.key)).toEqual(["diff.view"]);
    expect(viewsForPlacement("sidebar-left")).toEqual([]);
  });
});
