import { afterEach, expect, it, vi } from "vitest";
import {
  __resetPresentationClockForTest,
  presentationDocumentTimeFromUnixMs,
  presentationDocumentTimeFromUnixUs,
  presentationDocumentTimeFromWallBridgeUnixUs,
  presentationNowUnixMs,
  presentationNowUnixUs,
  presentationUnixMsFromDocumentTime,
} from "./presentationClock";

afterEach(() => {
  vi.unstubAllGlobals();
  __resetPresentationClockForTest();
});

it("uses only the document monotonic epoch, independent of OS wall clock correction", () => {
  const now = vi.fn().mockReturnValueOnce(25).mockReturnValueOnce(40);
  vi.stubGlobal("performance", { timeOrigin: 1_000, now });
  vi.stubGlobal("Date", { now: vi.fn().mockReturnValueOnce(99_000).mockReturnValueOnce(4) });

  expect(presentationNowUnixMs()).toBe(1_025);
  expect(presentationNowUnixMs()).toBe(1_040);
});

it("pins the first monotonic origin exactly once even without timeOrigin", () => {
  const now = vi.fn().mockReturnValueOnce(20).mockReturnValueOnce(35);
  const wall = vi.fn().mockReturnValueOnce(2_000).mockReturnValueOnce(90_000);
  vi.stubGlobal("performance", { timeOrigin: Number.NaN, now });
  vi.stubGlobal("Date", { now: wall });

  expect(presentationNowUnixMs()).toBe(2_000);
  expect(presentationNowUnixMs()).toBe(2_015);
  expect(wall).toHaveBeenCalledOnce();
});

it("the presentation epoch stays put when a running wall clock correction moves timeOrigin", () => {
  // WebKit does not hold `performance.timeOrigin` constant — it recomputes it from the current wall clock on
  // every read (MonotonicTime::approximateWallTime). So an OS time correction lands directly in this value.
  //
  // Measured (2026-08-07, buildId 02e65703, tauri/darwin, slot-freeze 12 transitions): during one run the wall
  // clock stepped 4.12s backward, this clock moved back by the same amount and diverged from the native
  // presentation clock pinned to uptime, and B04/B05 went red on both engines. The opposite sign of the same
  // defect (system sleep 67 minutes) is covered by `scripts/e2e/lib/browser-gate-b04-observed.test.mjs`.
  const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(200);
  let timeOrigin = 1_000_000;
  vi.stubGlobal("performance", { get timeOrigin() { return timeOrigin; }, now });

  expect(presentationNowUnixMs()).toBe(1_000_100);
  timeOrigin -= 4_120;
  expect(presentationNowUnixMs()).toBe(1_000_200);
});

it("the presentation time never moves backward when the wall clock steps back", () => {
  const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(11);
  let timeOrigin = 5_000;
  vi.stubGlobal("performance", { get timeOrigin() { return timeOrigin; }, now });

  const before = presentationNowUnixMs();
  timeOrigin -= 60_000;
  expect(presentationNowUnixMs()).toBeGreaterThan(before);
});

it("display frame time and now share one origin", () => {
  // Both functions write into one ledger (the framework display ledger). If the origins diverge, the display
  // time and the observation time inside that ledger come from two different clocks.
  const now = vi.fn().mockReturnValue(50);
  let timeOrigin = 700_000;
  vi.stubGlobal("performance", { get timeOrigin() { return timeOrigin; }, now });

  expect(presentationNowUnixMs()).toBe(700_050);
  timeOrigin += 9_000;
  expect(presentationUnixMsFromDocumentTime(50)).toBe(700_050);
});

it("uses the pinned origin when converting a native Unix presentation epoch back to the document timeline", () => {
  const now = vi.fn().mockReturnValue(100);
  let timeOrigin = 1_000;
  vi.stubGlobal("performance", { get timeOrigin() { return timeOrigin; }, now });

  expect(presentationNowUnixMs()).toBe(1_100);
  timeOrigin -= 30;
  expect(presentationDocumentTimeFromUnixMs(1_125.5)).toBe(125.5);
});

it("measured: large Unix ms subtraction breaks strict identity with the WebKit document time readback", () => {
  vi.stubGlobal("performance", { timeOrigin: 1_786_291_851_231, now: vi.fn().mockReturnValue(72_910) });
  expect(presentationDocumentTimeFromUnixMs(1_786_291_924_155.936)).toBe(72_924.93603515625);
  expect(presentationDocumentTimeFromUnixMs(1_786_291_924_155.936)).not.toBe(72_924.936);
});

it("subtracts safe integer Unix microseconds first to produce the exact WebKit document ms", () => {
  vi.stubGlobal("performance", { timeOrigin: 1_786_291_851_231, now: vi.fn().mockReturnValue(72_910) });
  expect(presentationNowUnixUs()).toBe(1_786_291_924_141_000);
  expect(presentationDocumentTimeFromUnixUs(1_786_291_924_155_936)).toBe(72_924.936);
});

it("a native callback transaction-local wall bridge never combines the old process monotonic origin", () => {
  const now = vi.fn().mockReturnValue(100);
  let timeOrigin = 3_000;
  vi.stubGlobal("performance", { get timeOrigin() { return timeOrigin; }, now });
  vi.stubGlobal("Date", { now: vi.fn().mockReturnValue(5_100) });

  // The long-lived ledger keeps its first origin.
  expect(presentationNowUnixUs()).toBe(3_100_000);
  timeOrigin = 5_000;

  // Only the candidate bridge reads the current document↔wall mapping. Converting back through the process
  // ledger origin arms it 2 seconds into the future, wrongly.
  expect(presentationDocumentTimeFromWallBridgeUnixUs(5_125_500)).toBe(125.5);
  expect(presentationDocumentTimeFromUnixUs(5_125_500)).toBe(2_125.5);
});

it("a native wall candidate converts through the wall-to-document pair at arm time, not a stale performance.timeOrigin", () => {
  // Observed FLOW RED: document monotonic is 2_681ms while performance.timeOrigin + now lags the current wall
  // clock by 3_632ms. Subtracting timeOrigin again arms the candidate at 6_318ms on the document timeline,
  // which stalls at currentTime=-3_632ms while only native advances.
  vi.stubGlobal("performance", {
    timeOrigin: 1_786_463_350_489,
    now: vi.fn().mockReturnValue(2_681),
  });
  vi.stubGlobal("Date", { now: vi.fn().mockReturnValue(1_786_463_356_802) });

  expect(
    presentationDocumentTimeFromWallBridgeUnixUs(1_786_463_356_807_270),
  ).toBe(2_686.27);
});

it.each([1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
  "rejects unsafe or non-integer Unix microseconds %s",
  (value) => {
    vi.stubGlobal("performance", { timeOrigin: 1_000, now: vi.fn().mockReturnValue(100) });
    expect(() => presentationDocumentTimeFromUnixUs(value)).toThrow("safe integer Unix microseconds");
  },
);
