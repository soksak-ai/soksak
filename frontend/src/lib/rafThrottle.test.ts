import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rafThrottle } from "./rafThrottle";

// Manual rAF control: collect the callbacks and advance one frame with frame().
let queue: FrameRequestCallback[] = [];
let nextId = 1;
let focusSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  queue = [];
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    // Test simplification: clear the whole queue instead of matching id (rafThrottle schedules only one at a time).
    void id;
    queue = [];
  });
  focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  focusSpy.mockRestore();
  vi.unstubAllGlobals();
});

function frame() {
  const cbs = queue;
  queue = [];
  for (const cb of cbs) cb(performance.now());
}

describe("rafThrottle", () => {
  it("in the background a one-shot task commits the last value instead of a stalled rAF", async () => {
    focusSpy.mockReturnValue(false);
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t(1);
    t(2);
    await new Promise<void>((resolve) => {
      const turn = new MessageChannel();
      turn.port1.onmessage = () => {
        turn.port1.close();
        turn.port2.close();
        resolve();
      };
      turn.port2.postMessage(null);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
    expect(queue).toHaveLength(0);
  });

  it("several calls in one frame merge into one call with the last argument", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t(1);
    t(2);
    t(3);
    expect(fn).not.toHaveBeenCalled();
    frame();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it("it runs at most once per frame", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t("a");
    frame();
    t("b");
    t("c");
    frame();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, "a");
    expect(fn).toHaveBeenNthCalledWith(2, "c");
  });

  it("flush() runs a pending call at once (the last value is committed)", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t(1);
    t(2);
    t.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
    frame(); // no duplicate run on a later frame
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush() with nothing pending does nothing", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() drops a pending call", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t(1);
    t.cancel();
    frame();
    expect(fn).not.toHaveBeenCalled();
    t.flush(); // flush after cancel is a no-op too
    expect(fn).not.toHaveBeenCalled();
  });

  it("a call after a run is scheduled on a new frame", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t(1);
    frame();
    t(2);
    frame();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
