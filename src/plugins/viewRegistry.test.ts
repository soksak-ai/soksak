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
  useViewRegistry.setState({ views: {}, version: 0 });
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
