import { describe, expect, it, vi } from "vitest";
import {
  createLayoutPresentationCoordinator,
  type LayoutPresentationParticipant,
  type LayoutPresentationStart,
} from "./layoutPresentationCoordinator";

const start = (transactionId: string): LayoutPresentationStart => {
  const candidate = {
    transactionId,
    producer: "display-callback" as const,
    clock: "unix-anchored-monotonic" as const,
    sourceGeneration: 7,
    frameSequence: 11,
    commandReceivedAtUnixUs: 1,
    installedAtUnixUs: 2,
    callbackReceivedAtUnixUs: 9_000_000_000_000_000,
    callbackObservedAtUnixMs: 12_337,
    callbackObservedAtUnixUs: 12_337_000,
    startAtUnixUs: 12_345_500,
    durationMs: 340,
    documentTimelineBridge: {
      producer: "display-callback-wall-bridge" as const,
      clock: "unix-wall" as const,
      callbackObservedAtUnixUs: 12_337_000,
      startAtUnixUs: 12_345_500,
    },
  };
  return {
    ...candidate,
    candidateAttempts: [{
      attempt: 1, candidate,
      armAcknowledgedParticipantIds: ["producer"], armFailures: [],
      armClock: "unix-anchored-monotonic", armStartedAtUnixUs: 12_338_000,
      armCompletedAtUnixUs: 12_340_000, armDurationUs: 2_000,
      acceptance: "accepted", acceptedAtUnixUs: 12_344_500, remainingLeadMs: 1,
      disarmedParticipantIds: [], disarmFailures: [],
      releasedParticipantIds: ["producer"], releaseFailures: [],
      rolledBackParticipantIds: [], rollbackFailures: [],
    }],
  };
};

function participant(id: string, log: string[]): LayoutPresentationParticipant {
  return {
    id,
    prepare: vi.fn(async (transactionId) => {
      log.push(`prepare:${id}:${transactionId}`);
      return {
        id,
        transactionId,
        start: vi.fn(async (receipt) => {
          log.push(`start:${id}:${receipt.transactionId}:${receipt.startAtUnixUs}`);
        }),
        cancel: vi.fn(() => log.push(`cancel:${id}:${transactionId}`)),
      };
    }),
  };
}

describe("layout presentation coordinator", () => {
  it("prepares every surface first, then issues exactly one producer epoch and starts them together", async () => {
    const log: string[] = [];
    const nextDisplay = vi.fn(async (transactionId: string) => {
      log.push(`epoch:${transactionId}`);
      return start(transactionId);
    });
    const coordinator = createLayoutPresentationCoordinator({ nextDisplay });

    const prepared = await coordinator.prepare({
      transactionId: "layout-9",
      participants: [participant("native", log), participant("windowed", log)],
    });
    expect(log).toEqual([
      "prepare:native:layout-9",
      "prepare:windowed:layout-9",
    ]);

    const receipt = await prepared.start();
    expect(receipt).toEqual(start("layout-9"));
    expect(nextDisplay).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      "prepare:native:layout-9",
      "prepare:windowed:layout-9",
      "epoch:layout-9",
      "start:native:layout-9:12345500",
      "start:windowed:layout-9:12345500",
    ]);
  });

  it("a differing producer or participant identity issues no DOM start receipt and cancels everything", async () => {
    const log: string[] = [];
    const coordinator = createLayoutPresentationCoordinator({
      nextDisplay: async () => start("another-layout"),
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-10",
      participants: [participant("native", log), participant("windowed", log)],
    });

    await expect(prepared.start()).rejects.toThrow("layout-10");
    expect(log).toContain("cancel:native:layout-10");
    expect(log).toContain("cancel:windowed:layout-10");
    expect(log.some((entry) => entry.startsWith("start:"))).toBe(false);
  });

  it("without producer clock, generation, and frame identity, a same-named timestamp is not accepted as a start", async () => {
    const log: string[] = [];
    const coordinator = createLayoutPresentationCoordinator({
      nextDisplay: async () => ({ ...start("layout-clock"), frameSequence: 0 }),
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-clock",
      participants: [participant("native", log)],
    });

    await expect(prepared.start()).rejects.toThrow("layout-clock");
    expect(log).toContain("cancel:native:layout-clock");
    expect(log.some((entry) => entry.startsWith("start:"))).toBe(false);
  });

  it("cancel closes every prepared participant once and rejects a later start", async () => {
    const log: string[] = [];
    const coordinator = createLayoutPresentationCoordinator({
      nextDisplay: async (transactionId) => start(transactionId),
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-11",
      participants: [participant("native", log), participant("windowed", log)],
    });
    prepared.cancel();
    prepared.cancel();

    expect(log.filter((entry) => entry === "cancel:native:layout-11")).toHaveLength(1);
    expect(log.filter((entry) => entry === "cancel:windowed:layout-11")).toHaveLength(1);
    await expect(prepared.start()).rejects.toThrow("cancelled");
  });
});
