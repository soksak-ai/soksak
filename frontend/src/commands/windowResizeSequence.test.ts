import { describe, expect, it, vi } from "vitest";
import { runWindowResizeSequence } from "./windowResizeSequence";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("window resize sequence", () => {
  it("opens recording first, applies every physical size in order, and lands on the last one", async () => {
    const order: string[] = [];
    let finishRecording!: (frames: number) => void;
    let markReady!: () => void;
    const finished = new Promise<number>((resolve) => { finishRecording = resolve; });
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const recording = Object.assign(finished, { ready, stopped: Promise.resolve(undefined) });
    const record = vi.fn(() => {
      order.push("record:start");
      return recording;
    });
    const setSize = vi.fn(async (w: number, h: number) => {
      order.push(`size:${w}x${h}`);
      if (w === 1200) finishRecording(12);
    });

    const resultPromise = runWindowResizeSequence({
      sizes: [{ w: 800, h: 600 }, { w: 1500, h: 700 }, { w: 1200, h: 900 }],
      intervalMs: 0,
      record: { dir: "/evidence/resize", frames: 12, intervalMs: 16 },
      setSize,
      recordFrames: record,
    });

    await Promise.resolve();
    expect(order).toEqual(["record:start"]);
    order.push("record:ready");
    markReady();
    const result = await resultPromise;

    expect(order).toEqual([
      "record:start",
      "record:ready",
      "size:800x600",
      "size:1500x700",
      "size:1200x900",
    ]);
    expect(result).toMatchObject({
      steps: 3,
      resizeElapsedMs: expect.any(Number),
      final: { w: 1200, h: 900 },
      recording: {
        status: "complete",
        mode: "realtime",
        dir: "/evidence/resize",
        requestedFrames: 12,
        frames: 12,
      },
    });
  });

  it("a transaction that requested no recording still publishes an explicit recording status", async () => {
    const recordFrames = vi.fn();
    const result = await runWindowResizeSequence({
      sizes: [{ w: 800, h: 600 }],
      intervalMs: 0,
      setSize: vi.fn(async () => {}),
      recordFrames: recordFrames as never,
    });

    expect(recordFrames).not.toHaveBeenCalled();
    expect(result.recording).toEqual({ status: "not-requested", mode: "realtime" });
    expect(result).not.toHaveProperty("frames");
  });

  it("completes every resize and observation in order even when recording readiness fails", async () => {
    const finished = deferred<number>();
    const readinessError = new Error("baseline capture failed");
    const recording = Object.assign(finished.promise, {
      ready: Promise.reject(readinessError),
      stopped: Promise.resolve(undefined),
    });
    const order: string[] = [];

    const result = await runWindowResizeSequence({
      sizes: [{ w: 800, h: 600 }, { w: 1400, h: 900 }],
      intervalMs: 0,
      record: { dir: "/evidence/resize", frames: 20, intervalMs: 16 },
      recordFrames: vi.fn(() => recording),
      setSize: vi.fn(async (w, h) => { order.push(`size:${w}x${h}`); }),
      observe: vi.fn(async (request) => {
        order.push(request.kind === "baseline" ? "observe:baseline" : `observe:${request.step}`);
        return { request };
      }),
    });

    expect(order).toEqual([
      "observe:baseline",
      "size:800x600",
      "observe:0",
      "size:1400x900",
      "observe:1",
    ]);
    expect(result.recording).toEqual({
      status: "failed",
      mode: "realtime",
      dir: "/evidence/resize",
      requestedFrames: 20,
      frames: 0,
      reason: "baseline capture failed",
    });
    finished.reject(readinessError);
    await Promise.resolve();
  });

  it("returns every resize and observation result even when the final recording fails after baseline", async () => {
    const finished = deferred<number>();
    const recording = Object.assign(finished.promise, { ready: Promise.resolve(), stopped: Promise.resolve(undefined) });
    const setSize = vi.fn(async (w: number) => {
      if (w === 1200) finished.reject(new Error("disk budget exhausted"));
    });

    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }, { w: 1200, h: 800 }],
      intervalMs: 0,
      record: { dir: "/evidence/resize", frames: 30, intervalMs: 10 },
      recordFrames: vi.fn(() => recording),
      setSize,
      observe: vi.fn(async (step) => ({ step })),
    });

    expect(setSize).toHaveBeenCalledTimes(2);
    expect(result.samples).toHaveLength(2);
    expect(result.recording).toEqual({
      status: "failed",
      mode: "realtime",
      dir: "/evidence/resize",
      requestedFrames: 30,
      frames: 0,
      reason: "disk budget exhausted",
    });
  });

  it("does not cancel the resize transaction when the recorder start call fails synchronously", async () => {
    const setSize = vi.fn(async () => {});
    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }, { w: 1300, h: 800 }],
      intervalMs: 0,
      record: { dir: "/evidence/resize", frames: 10, intervalMs: 16 },
      recordFrames: vi.fn(() => { throw new Error("recorder unavailable"); }),
      setSize,
    });

    expect(setSize).toHaveBeenCalledTimes(2);
    expect(result.recording).toEqual({
      status: "failed",
      mode: "realtime",
      dir: "/evidence/resize",
      requestedFrames: 10,
      frames: 0,
      reason: "recorder unavailable",
    });
  });

  it.each([0, -1, 1.5, 1_073_741_825, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses an invalid recording byte budget %s before the recorder and before any resize",
    async (maxBytes) => {
      const recordFrames = vi.fn();
      const setSize = vi.fn();
      await expect(runWindowResizeSequence({
        sizes: [{ w: 800, h: 600 }],
        intervalMs: 0,
        record: { dir: "/evidence/resize", frames: 10, intervalMs: 16, maxBytes },
        setSize,
        recordFrames: recordFrames as never,
      })).rejects.toThrow("maxBytes");
      expect(recordFrames).not.toHaveBeenCalled();
      expect(setSize).not.toHaveBeenCalled();
    },
  );

  it("admits neither an empty sequence nor an unbounded repeat", async () => {
    await expect(runWindowResizeSequence({
      sizes: [], intervalMs: 0,
      setSize: vi.fn(), recordFrames: vi.fn() as never,
    })).rejects.toThrow("sizes");
    await expect(runWindowResizeSequence({
      sizes: Array.from({ length: 121 }, () => ({ w: 800, h: 600 })), intervalMs: 0,
      setSize: vi.fn(), recordFrames: vi.fn() as never,
    })).rejects.toThrow("120");
  });

  it("records the public numeric facts of the same step right after each native resize answer", async () => {
    let current = "";
    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }, { w: 1500, h: 900 }],
      intervalMs: 0,
      setSize: vi.fn(async (w, h) => { current = `${w}x${h}`; }),
      observe: vi.fn(async (request) => ({ request, current })),
      recordFrames: vi.fn() as never,
    });
    expect(result.samples).toEqual([
      {
        step: 0,
        size: { w: 900, h: 700 },
        status: "observed",
        observation: { request: { kind: "step", step: 0, size: { w: 900, h: 700 } }, current: "900x700" },
      },
      {
        step: 1,
        size: { w: 1500, h: 900 },
        status: "observed",
        observation: { request: { kind: "step", step: 1, size: { w: 1500, h: 900 } }, current: "1500x900" },
      },
    ]);
  });

  it("takes a baseline through the same observation surface before the first native resize", async () => {
    const order: string[] = [];
    let current = "pre-resize";
    const observe = vi.fn(async (request: { kind: string; step?: number }) => {
      order.push(request.kind === "baseline" ? "observe:baseline" : `observe:${request.step}`);
      return { current };
    });

    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }, { w: 1500, h: 900 }],
      intervalMs: 0,
      setSize: vi.fn(async (w, h) => { current = `${w}x${h}`; order.push(`size:${w}x${h}`); }),
      observe,
      recordFrames: vi.fn() as never,
    });

    expect(order).toEqual([
      "observe:baseline",
      "size:900x700",
      "observe:0",
      "size:1500x900",
      "observe:1",
    ]);
    expect(result.baseline).toEqual({
      status: "observed",
      observation: { current: "pre-resize" },
    });
  });

  it("does not cancel the finite resize transaction when the baseline observation is refused, and keeps the reason", async () => {
    const order: string[] = [];
    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }, { w: 1500, h: 900 }],
      intervalMs: 0,
      setSize: vi.fn(async (w, h) => { order.push(`size:${w}x${h}`); }),
      observe: vi.fn(async (request) => {
        if (request.kind === "baseline") throw new Error("no settled native resize transaction yet");
        order.push(`observe:${request.step}`);
        return { step: request.step };
      }),
      recordFrames: vi.fn() as never,
    });

    expect(order).toEqual(["size:900x700", "observe:0", "size:1500x900", "observe:1"]);
    expect(result.samples).toHaveLength(2);
    expect(result.baseline).toEqual({
      status: "unavailable",
      reason: "no settled native resize transaction yet",
    });
  });

  it("exposes a step observation failure as it is instead of continuing the transaction", async () => {
    await expect(runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }, { w: 1500, h: 900 }],
      intervalMs: 0,
      setSize: vi.fn(async () => {}),
      observe: vi.fn(async (request) => {
        if (request.kind === "step") throw new Error("step observation failed");
        return {};
      }),
      recordFrames: vi.fn() as never,
    })).rejects.toThrow("step observation failed");
  });

  it("passes no requested size to the observation surface for a baseline request", async () => {
    const observe = vi.fn(async () => ({}));
    await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }],
      intervalMs: 0,
      setSize: vi.fn(async () => {}),
      observe,
      recordFrames: vi.fn() as never,
    });
    expect(observe).toHaveBeenNthCalledWith(1, { kind: "baseline" });
  });

  it("answers that it did not read a baseline instead of inventing one when there is no observation surface", async () => {
    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }],
      intervalMs: 0,
      setSize: vi.fn(async () => {}),
      recordFrames: vi.fn() as never,
    });
    expect(result.baseline).toEqual({ status: "not-observed" });
    expect(result.samples).toEqual([]);
  });

  it("marks null observations unavailable instead of reporting observed null", async () => {
    const result = await runWindowResizeSequence({
      sizes: [{ w: 900, h: 700 }],
      intervalMs: 0,
      setSize: vi.fn(async () => {}),
      observe: vi.fn(async () => null),
      recordFrames: vi.fn() as never,
    });

    expect(result.baseline).toEqual({
      status: "unavailable",
      reason: "resize observer returned no observation",
    });
    expect(result.samples).toEqual([{
      step: 0,
      size: { w: 900, h: 700 },
      status: "unavailable",
      reason: "resize observer returned no observation",
    }]);
    expect(result.measurement).toEqual({ passed: false, unavailableSteps: 1 });
  });
});
