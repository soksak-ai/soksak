// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A wait that cannot end, ends with the numbers that say why.
//
// `workspace.rightbar.toggle` closed the sidebar on screen and never answered. Measured on the
// running build 2026-08-16: two calls, both `did not answer within 20s`, while every other command
// replied and the panel had visibly closed. The handler awaits this function, and this function span
// requestAnimationFrame for as long as the commit stayed behind — no bound, no reading, no way for
// the caller to learn anything.
//
// A command that performs its work and never replies is a dead command from outside. The sequence is
// still the test, not elapsed time: what changes is that a wait which cannot finish names the two
// numbers rather than never returning.
vi.mock("../../../bindings/github.com/soksak-ai/soksak-core/frameworks/wails/nativepresentationservice", () => ({
  Commit: vi.fn(async () => ({ sequence: 0, accepted: true, surfaces: [] })),
}));
vi.mock("../../../bindings/github.com/min-median-max/wails-service-native-compositor/models", () => ({
  Snapshot: { createFrom: (value: unknown) => value },
}));
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

describe("waiting for the declared surfaces to be in a frame", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns at once when no observer is watching", async () => {
    const m = await import("./nativeSurfaces");
    await expect(m.nativeSurfacesSettled()).resolves.toBeUndefined();
  });

  it("refuses with the declared and committed sequence when the commit never catches up", async () => {
    const m = await import("./nativeSurfaces");
    m.__setNativeSurfaceStatusForTest(() => ({
      dirty: true,
      sequence: 9,
      committedSequence: 4,
      running: true,
      error: null,
    }));

    await expect(m.nativeSurfacesSettled(20)).rejects.toThrow(/9.*4|4.*9/);
  });

  // A window the system has stopped drawing produces no animation frame, and a wait that yields only
  // on one never gets to its own deadline: the command performs its work and answers nothing.
  // Measured 2026-08-17 on the running build, one run in three — `workspace.region.toggle` did not
  // answer inside the client's 20 seconds while the window sat behind another.
  it("ends on its deadline even when the window never draws a frame", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const m = await import("./nativeSurfaces");
    m.__setNativeSurfaceStatusForTest(() => ({
      dirty: true,
      sequence: 9,
      committedSequence: 4,
      running: true,
      error: null,
    }));

    const started = Date.now();
    await expect(m.nativeSurfacesSettled(60)).rejects.toThrow(/9.*4|4.*9/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("returns as soon as the commit catches up", async () => {
    const m = await import("./nativeSurfaces");
    let committed = 0;
    m.__setNativeSurfaceStatusForTest(() => {
      committed += 1;
      return {
        dirty: committed < 3,
        sequence: 9,
        committedSequence: committed < 3 ? 4 : 9,
        running: true,
        error: null,
      };
    });

    await expect(m.nativeSurfacesSettled(1_000)).resolves.toBeUndefined();
  });

  it("waits for a surface declaration event instead of probing ownership", async () => {
    const m = await import("./nativeSurfaces");
    const waiting = m.waitForNativeSurfaceDeclaration("terminal.win-test.tab-test", 1_000);
    queueMicrotask(() => {
      const surface = document.createElement("div");
      surface.dataset.nativeSurfaceId = "terminal.win-test.tab-test";
      document.body.append(surface);
    });
    await expect(waiting).resolves.toBeUndefined();
  });
});
