import { describe, it, expect } from "vitest";
import { suggestLayout, type MonitorFact, type WindowFact } from "./layoutSuggest";

// layout.suggest pure function (A4) — takes facts (window.monitors) and returns a layout proposal.
// Every judgment rule is here (the core supplies facts only); window.place performs the placement.

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
  it("spread, two monitors — the orchestrator takes the whole secondary monitor, the workspace takes the primary", () => {
    const out = suggestLayout({
      monitors: [mon(0, 0), mon(1, 2560)],
      windows: [win("win-1", 0), win("main", 0)],
      strategy: "spread",
      roles: { main: "orchestrator" },
    });
    const orch = out.find((p) => p.label === "main")!;
    const work = out.find((p) => p.label === "win-1")!;
    // Orchestrator = all of the monitor with no workspace on it (1).
    expect(orch.monitor).toBe(1);
    expect([orch.x, orch.y, orch.w, orch.h]).toEqual([2560, 0, 2560, 1440]);
    // Workspace = proposal to use all of its own monitor (0).
    expect(work.monitor).toBe(0);
    expect([work.x, work.w]).toEqual([0, 2560]);
  });

  it("spread, one monitor — the orchestrator takes the right third, the workspace the left two thirds, side by side with no overlap", () => {
    const out = suggestLayout({
      monitors: [mon(0, 0, 3000, 1500)],
      windows: [win("win-1", 0), win("main", 0)],
      strategy: "spread",
      roles: { main: "orchestrator" },
    });
    const orch = out.find((p) => p.label === "main")!;
    const work = out.find((p) => p.label === "win-1")!;
    expect(work.w).toBe(2000);
    expect(orch.x).toBe(2000);
    expect(orch.w).toBe(1000);
    // Full height.
    expect(orch.h).toBe(1500);
  });

  it("grid — N windows on one monitor in an even grid (two windows split it left and right)", () => {
    const out = suggestLayout({
      monitors: [mon(0, 0, 2000, 1000)],
      windows: [win("a", 0), win("b", 0)],
      strategy: "grid",
    });
    expect(out).toHaveLength(2);
    expect([out[0].x, out[0].w]).toEqual([0, 1000]);
    expect([out[1].x, out[1].w]).toEqual([1000, 1000]);
  });

  it("pure function — the input is unchanged (no mutation)", () => {
    const monitors = [mon(0, 0)];
    const windows = [win("a", 0)];
    const snapshot = JSON.stringify({ monitors, windows });
    suggestLayout({ monitors, windows, strategy: "grid" });
    expect(JSON.stringify({ monitors, windows })).toBe(snapshot);
  });
});
