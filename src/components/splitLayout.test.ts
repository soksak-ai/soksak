import { describe, it, expect } from "vitest";
import { computeSplitLayout, hitTestCells } from "./splitLayout";
import type { SplitTree } from "../state/splitTree";

// 공유 분할 레이아웃 — 콘텐츠/사이드바 공통. leaf 값에 무관(L=string 으로 검증).
type T = SplitTree<string>;

describe("computeSplitLayout", () => {
  it("leaf 하나 = 전체 rect", () => {
    const { cells, dividers } = computeSplitLayout<string>({ type: "leaf", value: "a" });
    expect(cells).toEqual([{ value: "a", rect: { left: 0, top: 0, width: 100, height: 100 } }]);
    expect(dividers).toEqual([]);
  });

  it("col 분할 = 세로 2셀 + divider 1", () => {
    const t: T = {
      type: "split",
      id: "s1",
      dir: "col",
      sizes: [0.7, 0.3],
      children: [
        { type: "leaf", value: "a" },
        { type: "leaf", value: "b" },
      ],
    };
    const { cells, dividers } = computeSplitLayout(t);
    expect(cells.map((c) => c.value)).toEqual(["a", "b"]);
    expect(cells[0].rect).toEqual({ left: 0, top: 0, width: 100, height: 70 });
    expect(cells[1].rect).toEqual({ left: 0, top: 70, width: 100, height: 30 });
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toMatchObject({ splitId: "s1", dir: "col", index: 0 });
  });

  it("row 분할 = 가로 2셀", () => {
    const t: T = {
      type: "split",
      id: "s1",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", value: "a" },
        { type: "leaf", value: "b" },
      ],
    };
    const { cells } = computeSplitLayout(t);
    expect(cells[0].rect).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    expect(cells[1].rect).toEqual({ left: 50, top: 0, width: 50, height: 100 });
  });
});

describe("hitTestCells", () => {
  const cells = computeSplitLayout<string>({ type: "leaf", value: "a" }).cells;
  // 컨테이너 100x100, 헤더 20, 상태 0. 본문 = y[20,100].
  const cr = { left: 0, top: 0, width: 100, height: 100 } as DOMRect;
  const opts = { chromeTop: 20, statusPx: 0 };

  it("본문 중앙 = center", () => {
    expect(hitTestCells(50, 60, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "center" });
  });
  it("좌측 가장자리 = left", () => {
    expect(hitTestCells(2, 60, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "left" });
  });
  it("우측 가장자리 = right", () => {
    expect(hitTestCells(98, 60, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "right" });
  });
  it("상단 가장자리(본문 내) = top", () => {
    // 본문 [20,100], 상단 ¼ ≈ y<40. y=24.
    expect(hitTestCells(50, 24, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "top" });
  });
  it("하단 가장자리 = bottom", () => {
    expect(hitTestCells(50, 96, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "bottom" });
  });
  it("헤더(탭 줄) 영역 = center(이동)", () => {
    expect(hitTestCells(50, 8, cr, cells, (v) => v, opts)).toEqual({ id: "a", zone: "center" });
  });
  it("selfCenterOnly: 자기 셀 위는 항상 center", () => {
    expect(
      hitTestCells(2, 60, cr, cells, (v) => v, { ...opts, sourceId: "a", selfCenterOnly: true }),
    ).toEqual({ id: "a", zone: "center" });
  });
  it("셀 밖 = null", () => {
    expect(hitTestCells(200, 200, cr, cells, (v) => v, opts)).toBeNull();
  });
});
