// @vitest-environment jsdom
// A settlement has a timestamp, and an owner that confirmed it.
//
// B05 judges "stimulus → transaction end → settlement → hold" on one time axis. That requires the
// settlement barrier to answer two things.
//
//  1) Settlement epoch — the absolute time the barrier closed. A caller stamping `Date.now()`
//     instead produces a different fact that includes the RPC round trip, on a different axis than
//     the batch ledger and the native display ledger.
//  2) syncPending — **whether the surface owner confirmed this settlement**. Answering `false` when
//     only the DOM went quiet and the surface owner confirmed nothing turns "unknown" into "sync
//     complete".
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginLayoutMotion, endLayoutMotion, __resetLayoutMotionForTest } from "../lib/layoutMotion";
import { waitLayoutSettled } from "./waitLayoutSettled";
import { __resetLayoutSettlementForTest } from "../lib/layoutSettlement";
import { presentationNowUnixMs } from "../lib/presentationClock";
import {
  __resetContentViewHostForTest,
  registerContentViewHost,
  type ContentViewHost,
} from "../lib/contentViews";
import { __resetPluginViewPresentationHostForTest } from "../plugins/viewPresentationHost";

afterEach(() => {
  __resetLayoutMotionForTest();
  __resetLayoutSettlementForTest();
  __resetContentViewHostForTest();
  __resetPluginViewPresentationHostForTest();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "getAnimations");
});

const noAnimations = () => {
  Object.defineProperty(document, "getAnimations", {
    configurable: true,
    value: vi.fn(() => []),
  });
};

function registerSurfaceOwner(settled: Promise<void>): void {
  registerContentViewHost({
    presentationSettled: async () => settled,
  } as unknown as ContentViewHost);
}

describe("waitLayoutSettled — the settle receipt", () => {
  it("a successful receipt states settled=true, with nothing inferred", async () => {
    noAnimations();
    registerSurfaceOwner(Promise.resolve());

    await expect(waitLayoutSettled()).resolves.toMatchObject({ settled: true });
  });

  it("the settle epoch is answered on the presentation clock", async () => {
    noAnimations();
    registerSurfaceOwner(Promise.resolve());
    const before = presentationNowUnixMs();
    const receipt = await waitLayoutSettled();
    const after = presentationNowUnixMs();

    expect(Number.isFinite(receipt.settledAtUnixMs)).toBe(true);
    expect(receipt.settledAtUnixMs).toBeGreaterThanOrEqual(before);
    expect(receipt.settledAtUnixMs).toBeLessThanOrEqual(after);
  });

  it("syncPending is false once the surface owner confirmed the settle", async () => {
    noAnimations();
    registerSurfaceOwner(Promise.resolve());
    const receipt = await waitLayoutSettled();
    expect(receipt.syncPending).toBe(false);
  });

  it("syncPending is true when the surface owner confirmed nothing — unknown is not reported as finished", async () => {
    noAnimations();
    const receipt = await waitLayoutSettled();
    expect(receipt.syncPending).toBe(true);
  });

  it("when the phase reopens and closes, the confirmation is a fact about the new settle", async () => {
    noAnimations();
    let confirm!: () => void;
    registerSurfaceOwner(new Promise<void>((resolve) => { confirm = resolve; }));
    beginLayoutMotion("move");
    const waiting = waitLayoutSettled();
    await Promise.resolve();
    endLayoutMotion("move");
    confirm();
    const receipt = await waiting;

    expect(receipt.syncPending).toBe(false);
    expect(receipt.settledAtUnixMs).toBeGreaterThan(0);
  });
});
