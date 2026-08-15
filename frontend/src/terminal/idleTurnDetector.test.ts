// idle provider — emits turn.ended(idle) after an output burst plus a no-output debounce. ptyBridge is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers: {
  start?: (paneId: string, cmd: string, cwd: string | null) => void;
  finish?: (paneId: string) => void;
  out?: () => void;
} = {};

vi.mock("./ptyBridge", () => ({
  subscribeAnyCommandStarted: (cb: typeof handlers.start) => {
    handlers.start = cb;
    return () => {
      handlers.start = undefined;
    };
  },
  subscribeAnyCommandFinished: (cb: typeof handlers.finish) => {
    handlers.finish = cb;
    return () => {
      handlers.finish = undefined;
    };
  },
  subscribeOutput: (_tabId: string, cb: () => void) => {
    handlers.out = cb;
    return () => {
      handlers.out = undefined;
    };
  },
}));

import {
  configureIdleTurnDetector,
  isIdleTurnDetectionOn,
  resetIdleTurnDetectorForTest,
  setIdleTurnDetection,
} from "./idleTurnDetector";

beforeEach(() => {
  vi.useFakeTimers();
  resetIdleTurnDetectorForTest();
});
afterEach(() => vi.useRealTimers());

describe("idleTurnDetector", () => {
  it("off by default — nothing runs before it is turned on", () => {
    configureIdleTurnDetector({ emit: () => {}, projectInfoOf: () => null });
    expect(isIdleTurnDetectionOn()).toBe(false);
  });

  it("N ms with no output after an output burst emits turn.ended(idle) once", () => {
    const emitted: unknown[] = [];
    configureIdleTurnDetector({ emit: (p) => emitted.push(p), projectInfoOf: () => ({ id: "pjt-aaaaaa", root: "projA" }) });
    setIdleTurnDetection(true, 1000);
    expect(isIdleTurnDetectionOn()).toBe(true);

    handlers.start?.("tab-aaaaaa", "claude", null); // monitor starts (no timer before output)
    vi.advanceTimersByTime(2000);
    expect(emitted).toHaveLength(0); // no output, no false positive

    handlers.out?.(); // output burst → arm
    vi.advanceTimersByTime(999);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1); // 1000ms with no output → fire
    expect(emitted).toEqual([{ projectId: "pjt-aaaaaa", root: "projA", paneId: "tab-aaaaaa", source: "idle" }]);
  });

  it("the monitor is released when the command finishes (later output is ignored)", () => {
    const emitted: unknown[] = [];
    configureIdleTurnDetector({ emit: (p) => emitted.push(p), projectInfoOf: () => null });
    setIdleTurnDetection(true, 500);
    handlers.start?.("tab-aaaaaa", "x", null);
    handlers.finish?.("tab-aaaaaa"); // release
    handlers.out?.(); // output after release — ignored (unsub clears handlers.out)
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(0);
  });

  it("setIdleTurnDetection(false) stops it", () => {
    configureIdleTurnDetector({ emit: () => {}, projectInfoOf: () => null });
    setIdleTurnDetection(true);
    expect(isIdleTurnDetectionOn()).toBe(true);
    setIdleTurnDetection(false);
    expect(isIdleTurnDetectionOn()).toBe(false);
  });
});
