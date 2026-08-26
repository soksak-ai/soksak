// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vitest";
import { createStream, invoke } from "../framework";
import {
  recordWindowFrames,
  startWindowRecording,
  validWindowRecordFrameTimeoutMs,
  validWindowRecordFrames,
  validWindowRecordIntervalMs,
  WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS,
  WINDOW_RECORD_MAX_INTERVAL_MS,
  WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS,
} from "./windowRecorder";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(),
  createStream: vi.fn(),
}));

const readyStream = { onmessage: (_message: number) => {}, close: vi.fn() };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(createStream).mockClear();
  readyStream.close.mockClear();
  vi.mocked(createStream).mockReturnValue(readyStream as never);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "window_record") return undefined;
    // The host answers a report, not a bare count: what landed on disk is not always what was
    // asked for, and the reason travels with the number.
    return { frames: args?.frames };
  });
});

it("one shared record contract stores a finite frame sequence", async () => {
  const observed: number[] = [];
  const recording = recordWindowFrames({
    dir: "<local-evidence>/framework-neutral-record",
    frames: 2,
    intervalMs: 0,
    onFrame: (frame) => observed.push(frame),
  });
  readyStream.onmessage(0);
  readyStream.onmessage(1);
  await recording.ready;
  const frames = await recording;

  expect(frames).toBe(2);
  expect(observed).toEqual([0, 1]);
  expect(vi.mocked(invoke)).toHaveBeenCalledOnce();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("window_record", {
    dir: "<local-evidence>/framework-neutral-record",
    frames: 2,
    intervalMs: 0,
    frameTimeoutMs: WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS,
    onFrame: readyStream,
  });
  expect(readyStream.close).toHaveBeenCalledOnce();
});

it("the storage budget reaches the producer unchanged, with no framework branch, and readiness is preserved", async () => {
  const recording = recordWindowFrames({
    dir: "<local-evidence>/framework-neutral-budget-record",
    frames: 1,
    intervalMs: 0,
    maxBytes: 1_048_576,
  });

  readyStream.onmessage(0);
  await expect(recording.ready).resolves.toBeUndefined();
  await expect(recording).resolves.toBe(1);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("window_record", {
    dir: "<local-evidence>/framework-neutral-budget-record",
    frames: 1,
    intervalMs: 0,
    maxBytes: 1_048_576,
    frameTimeoutMs: WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS,
    onFrame: readyStream,
  });
});

it("every framework call states the shared producer deadline", async () => {
  expect(validWindowRecordFrameTimeoutMs(1)).toBe(true);
  expect(validWindowRecordFrameTimeoutMs(WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS)).toBe(true);
  expect(validWindowRecordFrameTimeoutMs(0)).toBe(false);
  expect(validWindowRecordFrameTimeoutMs(WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS + 1)).toBe(false);

  const defaultRecording = recordWindowFrames({
    dir: "<local-evidence>/framework-neutral-default-deadline",
    frames: 1,
    intervalMs: 0,
  });
  readyStream.onmessage(0);
  await defaultRecording;
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith(
    "window_record",
    expect.objectContaining({ frameTimeoutMs: WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS }),
  );

  const explicitRecording = recordWindowFrames({
    dir: "<local-evidence>/framework-neutral-explicit-deadline",
    frames: 1,
    intervalMs: 0,
    frameTimeoutMs: 25,
  });
  readyStream.onmessage(0);
  await explicitRecording;
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith(
    "window_record",
    expect.objectContaining({ frameTimeoutMs: 25 }),
  );
});

it("the shared recorder does not alter frames or intervalMs and rejects strictly before the producer", () => {
  expect(validWindowRecordFrames(1)).toBe(true);
  expect(validWindowRecordFrames(600)).toBe(true);
  expect(validWindowRecordIntervalMs(0)).toBe(true);
  expect(validWindowRecordIntervalMs(WINDOW_RECORD_MAX_INTERVAL_MS)).toBe(true);
  expect(validWindowRecordIntervalMs(WINDOW_RECORD_MAX_INTERVAL_MS + 1)).toBe(false);

  for (const frames of [0, -1, 1.5, 601, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => recordWindowFrames({
      dir: "<local-evidence>/rejected-frames",
      frames,
      intervalMs: 0,
    })).toThrow("frames");
  }
  for (const intervalMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => recordWindowFrames({
      dir: "<local-evidence>/rejected-interval",
      frames: 1,
      intervalMs,
    })).toThrow("intervalMs");
  }
  expect(createStream).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it("callers use only the shared recorder and never call the framework record directly", () => {
  for (const file of ["catalog.ts", "catalogCapture.ts", "catalogDom.ts", "catalogSettings.ts"]) {
    const source = readFileSync(join(__dirname, file), "utf8");
    expect(source, file).not.toContain("window_record");
  }
});

it("a ready failure closes as failed without awaiting an unfinished final, and consumes the final rejection at once", async () => {
  let rejectFinal!: (reason: unknown) => void;
  const final = new Promise<number>((_resolve, reject) => { rejectFinal = reject; });
  const recorder = vi.fn(() => Object.assign(final, {
    ready: Promise.reject(new Error("baseline failed")),
    stopped: Promise.resolve(undefined),
  }));

  const transaction = startWindowRecording({
    dir: "/evidence/ready-failure",
    frames: 8,
    intervalMs: 16,
  }, recorder);

  await expect(transaction.ready).resolves.toBe(false);
  await expect(transaction.report).resolves.toEqual({
    status: "failed",
    mode: "realtime",
    dir: "/evidence/ready-failure",
    requestedFrames: 8,
    frames: 0,
    reason: "baseline failed",
  });
  rejectFinal(new Error("late final failure"));
  await Promise.resolve();
});

it("after ready succeeds, final success and failure close under the same public status contract", async () => {
  const complete = startWindowRecording({
    dir: "/evidence/complete",
    frames: 2,
    intervalMs: 0,
  }, (request) => {
    request.onFrame?.(0);
    request.onFrame?.(1);
    return Object.assign(Promise.resolve(2), { ready: Promise.resolve(), stopped: Promise.resolve(undefined) });
  });
  await expect(complete.ready).resolves.toBe(true);
  await expect(complete.report).resolves.toMatchObject({
    status: "complete",
    frames: 2,
    requestedFrames: 2,
  });

  const failed = startWindowRecording({
    dir: "/evidence/final-failure",
    frames: 3,
    intervalMs: 0,
  }, (request) => {
    request.onFrame?.(0);
    return Object.assign(Promise.reject(new Error("disk failed")), { ready: Promise.resolve(), stopped: Promise.resolve(undefined) });
  });
  await expect(failed.ready).resolves.toBe(true);
  await expect(failed.report).resolves.toMatchObject({
    status: "failed",
    frames: 1,
    reason: "disk failed",
  });
});

it("a synchronous recorder failure and a frame observer failure surface as recording status instead of a throw", async () => {
  const sync = startWindowRecording({
    dir: "/evidence/sync-failure",
    frames: 1,
    intervalMs: 0,
  }, () => { throw new Error("recorder unavailable"); });
  await expect(sync.ready).resolves.toBe(false);
  await expect(sync.report).resolves.toMatchObject({
    status: "failed",
    frames: 0,
    reason: "recorder unavailable",
  });

  const observer = startWindowRecording({
    dir: "/evidence/observer-failure",
    frames: 1,
    intervalMs: 0,
    onFrame: () => { throw new Error("observer failed"); },
  }, (request) => {
    request.onFrame?.(0);
    return Object.assign(Promise.resolve(1), { ready: Promise.resolve(), stopped: Promise.resolve(undefined) });
  });
  await expect(observer.report).resolves.toMatchObject({
    status: "failed",
    frames: 1,
    reason: "observer failed",
  });
});

it("a recorder with no ready contract is not reported as a baseline success", async () => {
  const incomplete = Promise.resolve(1) as ReturnType<typeof recordWindowFrames>;
  const transaction = startWindowRecording({
    dir: "/evidence/missing-ready",
    frames: 1,
    intervalMs: 0,
  }, () => incomplete);

  await expect(transaction.ready).resolves.toBe(false);
  await expect(transaction.report).resolves.toMatchObject({
    status: "failed",
    mode: "realtime",
    dir: "/evidence/missing-ready",
    requestedFrames: 1,
    frames: 0,
    reason: expect.stringContaining("ready"),
  });
});

it("the raw recorder also attaches a final rejection consumer before it returns", async () => {
  // The consumer is judged by what it prevents, not by its place in the chain.
  // Spying the producer's own catch tied this to one arrangement of the chain: reading the frame
  // count off the report adds a link, and the test failed while the contract held. What matters is
  // that a caller who starts a recording and does not await it immediately never sees an
  // unhandledrejection.
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    unhandled.push(event.reason);
  };
  window.addEventListener("unhandledrejection", onUnhandled);
  vi.mocked(invoke).mockReturnValueOnce(Promise.reject(new Error("capture failed")) as never);

  const recording = recordWindowFrames({
    dir: "/evidence/raw-rejection",
    frames: 1,
    intervalMs: 0,
  });

  // A full turn of the microtask queue and a macrotask, which is when an unconsumed rejection
  // would be reported.
  await new Promise((resolve) => setTimeout(resolve, 0));
  window.removeEventListener("unhandledrejection", onUnhandled);
  expect(unhandled).toEqual([]);

  await expect(recording.ready).rejects.toThrow("capture failed");
  await expect(recording).rejects.toThrow("capture failed");
});
