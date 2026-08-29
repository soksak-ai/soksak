import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  invoke: vi.fn(),
  record: vi.fn(),
}));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: mocked.invoke,
}));
vi.mock("./windowRecorder", () => ({ startWindowRecording: mocked.record }));
vi.mock("../lib/contentViews", () => ({
  lastAppliedSurfaces: () => ({ surfaces: [] }),
}));
vi.mock("../lib/parkedPicture", () => ({ parkedPicture: () => null }));
vi.mock("../lib/surfaceLabels", () => ({ surfaceLabelOfView: () => null }));

import { runSwitchScan } from "./switchScanRuntime";

describe("frame-driven switch scan", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div data-node="layout/tab/from" data-content-visible="true" data-surface-visible="false"></div>
      <div data-node="layout/tab/to" data-content-visible="false" data-surface-visible="false"></div>`;
    mocked.invoke.mockReset();
    mocked.record.mockReset();
    mocked.record.mockImplementation((request: { frames: number; onFrame?: (frame: number) => void }) => {
      for (let frame = 0; frame < request.frames; frame += 1) request.onFrame?.(frame);
      return {
        ready: Promise.resolve(true),
        report: Promise.resolve({
          status: "complete",
          mode: "realtime",
          dir: "/recording",
          requestedFrames: request.frames,
          frames: request.frames,
        }),
      };
    });
    mocked.invoke.mockResolvedValue({
      frames: 6,
      regions: [{
        name: "switch-content",
        frames: [
          { frame: 0 },
          { frame: 1, changed: 0 },
          { frame: 2, changed: 0 },
          { frame: 3, changed: 0 },
          { frame: 4, changed: 0 },
          { frame: 5, changed: 0.2 },
        ],
      }],
    });
  });

  it("activates after the addressed saved frame and reports one clean transition", async () => {
    const activate = vi.fn(() => {
      document.querySelector<HTMLElement>('[data-node="layout/tab/from"]')!.dataset.contentVisible = "false";
      document.querySelector<HTMLElement>('[data-node="layout/tab/to"]')!.dataset.contentVisible = "true";
      return Promise.resolve({
        changed: true as const,
        layoutMoved: false as const,
        presentation: { kind: "tab" as const, id: "to", phase: "presentation-settled" as const },
        transaction: null,
      });
    });
    const result = await runSwitchScan({
      dir: "/recording",
      frames: 6,
      intervalMs: 16,
      applyAtFrame: 4,
      region: { x0: 0, y0: 0, x1: 1, y1: 1 },
      threshold: 0.003,
      fromViews: ["from"],
      toViews: ["to"],
      activate,
    });

    expect(activate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      switchFrame: 5,
      switchFrames: 1,
      flickerFrames: 0,
      blankFrames: [],
      overlapFrames: [],
      nativeMismatchFrames: [],
      clean: true,
      activation: {
        changed: true,
        layoutMoved: false,
        presentation: { kind: "tab", id: "to", phase: "presentation-settled" },
        transaction: null,
      },
    });
    expect(result.presentationFrames[4]).toMatchObject({
      frame: 4,
      from: [{ contentVisible: true }],
      to: [{ contentVisible: false }],
    });
    expect(result.presentationFrames[5]).toMatchObject({
      frame: 5,
      from: [{ contentVisible: false }],
      to: [{ contentVisible: true }],
    });
  });
});
