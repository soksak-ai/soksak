import { afterEach, describe, expect, it, vi } from "vitest";
import { afterFramePaint } from "./afterFramePaint";

afterEach(() => vi.unstubAllGlobals());

describe("after frame paint", () => {
  it("does not resolve inside the animation-frame callback", async () => {
    let frame!: FrameRequestCallback;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    let resolved = false;
    const wait = afterFramePaint().then(() => { resolved = true; });
    frame(1);
    expect(resolved).toBe(false);
    await wait;
    expect(resolved).toBe(true);
  });
});
