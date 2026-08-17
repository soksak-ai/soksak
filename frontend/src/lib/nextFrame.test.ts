// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextFrame } from "./nextFrame";

// A wait for a frame ends whether or not the window draws one.
//
// A window the system has stopped drawing produces no animation frame, and every command that awaits
// one then answers nothing — measured 2026-08-17, `workspace.region.toggle` silent past 20 seconds,
// one run in three.

describe("waiting for a frame", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves on the frame when the window is drawing", async () => {
    let asked = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      asked += 1;
      queueMicrotask(() => callback(0));
      return 1;
    });

    await expect(nextFrame(5_000)).resolves.toBeUndefined();
    expect(asked).toBe(1);
  });

  it("resolves on the timer when the window draws nothing", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);

    const started = Date.now();
    await expect(nextFrame(20)).resolves.toBeUndefined();
    // Without the second clock this never returns, and the test would end on the runner's timeout
    // rather than here.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("resolves once, whichever clock arrives first", async () => {
    let resolved = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });

    await nextFrame(1).then(() => {
      resolved += 1;
    });
    await new Promise((done) => setTimeout(done, 30));
    expect(resolved).toBe(1);
  });
});
