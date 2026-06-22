import { describe, it, expect } from "vitest";
import {
  initialSidebarLayout,
  reconcileSidebarLayout,
  moveSidebarView,
  sidebarViewKeys,
  activeKeysOf,
  type SidebarLayout,
} from "./sidebarLayout";
import { leavesOf, type SplitTree } from "./splitTree";

// 좌측 사이드바 레이아웃 = SplitTree<SidebarGroup>. leaf = 탭 묶음(viewKeys + active), split = 세로 분할.
// 콘텐츠 영역과 동일한 drag-merge 를 위해 SplitTree 를 재사용한다. 등록 뷰와 reconcile(추가/제거).

let sid = 0;
const newSplitId = () => `S${++sid}`;

const single = (keys: string[]): SidebarLayout => ({
  type: "leaf",
  value: { viewKeys: keys, activeViewKey: keys[0] ?? "" },
});

describe("initialSidebarLayout", () => {
  it("등록 뷰 전부를 한 leaf 탭 묶음으로(첫 뷰 활성)", () => {
    const l = initialSidebarLayout(["a.x", "b.y"]);
    expect(l).toEqual(single(["a.x", "b.y"]));
  });
  it("빈 등록 = 빈 leaf", () => {
    expect(initialSidebarLayout([])).toEqual(single([]));
  });
});

describe("reconcileSidebarLayout", () => {
  it("새 등록 뷰는 첫 leaf 탭에 추가", () => {
    const l = single(["a.x"]);
    const r = reconcileSidebarLayout(l, ["a.x", "b.y"]);
    expect(sidebarViewKeys(r)).toEqual(["a.x", "b.y"]);
  });

  it("사라진 뷰는 제거, 빈 leaf 는 붕괴", () => {
    sid = 0;
    const split: SidebarLayout = {
      type: "split",
      id: "s1",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [single(["a.x"]), single(["b.y"])],
    };
    const r = reconcileSidebarLayout(split, ["a.x"]); // b.y 등록 해제
    expect(r).toEqual(single(["a.x"])); // b.y leaf 제거 → 붕괴
  });

  it("활성 뷰가 사라지면 leaf 의 활성을 첫 뷰로 보정", () => {
    const l: SidebarLayout = {
      type: "leaf",
      value: { viewKeys: ["a.x", "b.y"], activeViewKey: "b.y" },
    };
    const r = reconcileSidebarLayout(l, ["a.x"]); // b.y 제거(활성이었음)
    const g = (r as Extract<SidebarLayout, { type: "leaf" }>).value;
    expect(g.viewKeys).toEqual(["a.x"]);
    expect(g.activeViewKey).toBe("a.x");
  });

  it("변화 없으면 그대로(키 순서·active 보존)", () => {
    const l: SidebarLayout = {
      type: "leaf",
      value: { viewKeys: ["a.x", "b.y"], activeViewKey: "b.y" },
    };
    expect(reconcileSidebarLayout(l, ["a.x", "b.y"])).toEqual(l);
  });
});

describe("moveSidebarView (drag-merge)", () => {
  it("center: 다른 leaf 로 탭 이동(원 leaf 에서 제거, 대상 leaf 에 추가+활성)", () => {
    sid = 0;
    const split: SidebarLayout = {
      type: "split",
      id: "s1",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [single(["a.x", "b.y"]), single(["c.z"])],
    };
    // a.x 를 두번째 leaf(c.z 그룹)로 center 이동
    const r = moveSidebarView(split, "a.x", { type: "into", targetKey: "c.z" }, newSplitId);
    const groups = leavesOf(r as SplitTree<{ viewKeys: string[]; activeViewKey: string }>);
    expect(groups[0].viewKeys).toEqual(["b.y"]); // a.x 빠짐
    expect(groups[1].viewKeys).toEqual(["c.z", "a.x"]); // a.x 합류
    expect(groups[1].activeViewKey).toBe("a.x"); // 이동=활성
  });

  it("split: 대상 옆에 새 leaf 로 분리(세로)", () => {
    sid = 0;
    const l = single(["a.x", "b.y"]);
    // b.y 를 a.x 아래로 split(분리)
    const r = moveSidebarView(l, "b.y", { type: "split", targetKey: "a.x", before: false }, newSplitId);
    expect(r.type).toBe("split");
    const groups = leavesOf(r as SplitTree<{ viewKeys: string[]; activeViewKey: string }>);
    expect(groups.map((g) => g.viewKeys)).toEqual([["a.x"], ["b.y"]]);
  });

  it("마지막 한 뷰를 split 하려 하면 무의미 → 변화 없음", () => {
    sid = 0;
    const l = single(["a.x"]);
    const r = moveSidebarView(l, "a.x", { type: "split", targetKey: "a.x", before: false }, newSplitId);
    expect(r).toEqual(l);
  });
});

describe("activeKeysOf", () => {
  it("각 leaf 의 활성 viewKey 수집(렌더할 뷰들)", () => {
    const split: SidebarLayout = {
      type: "split",
      id: "s1",
      dir: "col",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", value: { viewKeys: ["a.x", "b.y"], activeViewKey: "b.y" } },
        { type: "leaf", value: { viewKeys: ["c.z"], activeViewKey: "c.z" } },
      ],
    };
    expect(activeKeysOf(split).sort()).toEqual(["b.y", "c.z"]);
  });
});
