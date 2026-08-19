// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { noteAppliedSurfaces } from "./contentViews";
import { layoutTrace, startLayoutTrace, stopLayoutTrace, whenLayoutTraceEnds } from "./layoutTrace";

describe("layout trace native presentation facts", () => {
  afterEach(() => {
    stopLayoutTrace();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("records interactive, presented, and raw settled geometry in one frame", async () => {
    const declaration = document.createElement("div");
    declaration.dataset.nativeSurface = "browser";
    declaration.dataset.nativeSurfaceId = "browser.win-a.tab-a";
    declaration.dataset.nativeDeclaredFrame = "40,20,760,580";
    vi.spyOn(declaration, "getBoundingClientRect").mockReturnValue({
      x: 40, y: 20, left: 40, top: 20, right: 800, bottom: 600,
      width: 760, height: 580, toJSON: () => ({}),
    });
    document.body.append(declaration);

    noteAppliedSurfaces([{
      id: "browser.win-a.tab-a",
      x: 40, y: 20, w: 760, h: 580,
      settled: { x: 256, y: 20, w: 544, h: 580 },
      visible: true,
    }], 1000, 8, 0.2, 1, true);

    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) =>
      setTimeout(() => run(performance.now()), 1) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
    const started = await startLayoutTrace(20);
    await whenLayoutTraceEnds(started.run, 2000);

    const frame = layoutTrace().frames[0];
    expect(frame.interactive).toBe(true);
    expect(frame.surfaces[0]).toMatchObject({
      applied: { x: 40, y: 20, w: 760, h: 580 },
      settled: { x: 256, y: 20, w: 544, h: 580 },
    });
  });
});
