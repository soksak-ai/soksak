// idle provider — 출력 버스트 후 무출력 디바운스로 turn.ended(idle) 발화. paneHosts 는 mock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers: {
  start?: (paneId: string, cmd: string, cwd: string | null) => void;
  finish?: (paneId: string) => void;
  out?: () => void;
} = {};

vi.mock("./paneHosts", () => ({
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
  subscribeOutput: (_paneId: string, cb: () => void) => {
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
  it("기본 OFF — 켜기 전엔 동작 안 함", () => {
    configureIdleTurnDetector({ emit: () => {}, projectInfoOf: () => null });
    expect(isIdleTurnDetectionOn()).toBe(false);
  });

  it("출력 후 N ms 무출력 → turn.ended(idle) 1회", () => {
    const emitted: unknown[] = [];
    configureIdleTurnDetector({ emit: (p) => emitted.push(p), projectInfoOf: () => ({ id: "t1", root: "projA" }) });
    setIdleTurnDetection(true, 1000);
    expect(isIdleTurnDetectionOn()).toBe(true);

    handlers.start?.("pane1", "claude", null); // 모니터 시작(출력 전엔 타이머 없음)
    vi.advanceTimersByTime(2000);
    expect(emitted).toHaveLength(0); // 출력 없으면 오탐 없음

    handlers.out?.(); // 출력 버스트 → arm
    vi.advanceTimersByTime(999);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1); // 1000ms 무출력 → 발화
    expect(emitted).toEqual([{ projectId: "t1", root: "projA", paneId: "pane1", source: "idle" }]);
  });

  it("명령 종료 시 모니터 해제(이후 출력은 무시)", () => {
    const emitted: unknown[] = [];
    configureIdleTurnDetector({ emit: (p) => emitted.push(p), projectInfoOf: () => null });
    setIdleTurnDetection(true, 500);
    handlers.start?.("pane1", "x", null);
    handlers.finish?.("pane1"); // 해제
    handlers.out?.(); // 해제 후 출력 — 무시(handlers.out 은 unsub 으로 비워짐)
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(0);
  });

  it("setIdleTurnDetection(false) 로 정지", () => {
    configureIdleTurnDetector({ emit: () => {}, projectInfoOf: () => null });
    setIdleTurnDetection(true);
    expect(isIdleTurnDetectionOn()).toBe(true);
    setIdleTurnDetection(false);
    expect(isIdleTurnDetectionOn()).toBe(false);
  });
});
