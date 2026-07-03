import { describe, it, expect } from "vitest";
import { suggestLayout, type MonitorFact, type WindowFact } from "./layoutSuggest";

// layout.suggest 순수함수(A4) — 팩트(window.monitors)를 받아 배치 제안을 돌려준다.
// 판단 규칙이 여기 전부 있고(코어 Rust 는 팩트만), 실행은 window.place 가 한다.

const mon = (index: number, x: number, w = 2560, h = 1440): MonitorFact => ({
  index,
  name: `m${index}`,
  x,
  y: 0,
  w,
  h,
  scale: 2,
});
const win = (label: string, monitor: number | null): WindowFact => ({
  label,
  x: 0,
  y: 0,
  w: 800,
  h: 600,
  focused: false,
  monitor,
});

describe("suggestLayout", () => {
  it("spread: 듀얼 모니터 — 오케스트레이터는 보조 모니터 전체, 워크스페이스는 주 모니터", () => {
    const out = suggestLayout({
      monitors: [mon(0, 0), mon(1, 2560)],
      windows: [win("main", 0), win("orch-1", 0)],
      strategy: "spread",
      roles: { "orch-1": "orchestrator" },
    });
    const orch = out.find((p) => p.label === "orch-1")!;
    const main = out.find((p) => p.label === "main")!;
    // 오케스트레이터 = 워크스페이스가 없는 모니터(1) 전체.
    expect(orch.monitor).toBe(1);
    expect([orch.x, orch.y, orch.w, orch.h]).toEqual([2560, 0, 2560, 1440]);
    // 워크스페이스 = 자기 모니터(0) 전체 사용 제안.
    expect(main.monitor).toBe(0);
    expect([main.x, main.w]).toEqual([0, 2560]);
  });

  it("spread: 단일 모니터 — 오케스트레이터 우측 1/3, 워크스페이스 좌측 2/3(겹침 없이 나란히)", () => {
    const out = suggestLayout({
      monitors: [mon(0, 0, 3000, 1500)],
      windows: [win("main", 0), win("orch-1", 0)],
      strategy: "spread",
      roles: { "orch-1": "orchestrator" },
    });
    const orch = out.find((p) => p.label === "orch-1")!;
    const main = out.find((p) => p.label === "main")!;
    expect(main.w).toBe(2000);
    expect(orch.x).toBe(2000);
    expect(orch.w).toBe(1000);
    // 세로는 전체.
    expect(orch.h).toBe(1500);
  });

  it("grid: 창 N 개를 한 모니터에 균등 그리드(2창=좌우 반분)", () => {
    const out = suggestLayout({
      monitors: [mon(0, 0, 2000, 1000)],
      windows: [win("a", 0), win("b", 0)],
      strategy: "grid",
    });
    expect(out).toHaveLength(2);
    expect([out[0].x, out[0].w]).toEqual([0, 1000]);
    expect([out[1].x, out[1].w]).toEqual([1000, 1000]);
  });

  it("순수함수 — 입력 불변(mutation 없음)", () => {
    const monitors = [mon(0, 0)];
    const windows = [win("a", 0)];
    const snapshot = JSON.stringify({ monitors, windows });
    suggestLayout({ monitors, windows, strategy: "grid" });
    expect(JSON.stringify({ monitors, windows })).toBe(snapshot);
  });
});
