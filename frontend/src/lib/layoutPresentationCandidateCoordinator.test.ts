import { describe, expect, it, vi } from "vitest";
import {
  createLayoutPresentationCandidateCoordinator,
  type LayoutPresentationCandidate,
  type LayoutPresentationCandidateParticipant,
} from "./layoutPresentationCandidateCoordinator";

const candidate = (transactionId: string, frameSequence: number): LayoutPresentationCandidate => ({
  transactionId,
  producer: "display-callback",
  clock: "unix-anchored-monotonic",
  sourceGeneration: 7,
  frameSequence,
  commandReceivedAtUnixUs: (12_000 + frameSequence - 10) * 1_000,
  installedAtUnixUs: (12_000 + frameSequence - 9) * 1_000,
  callbackReceivedAtUnixUs: (12_000 + frameSequence - 8) * 1_000 + 500,
  callbackObservedAtUnixMs: 12_000 + frameSequence - 8,
  callbackObservedAtUnixUs: (12_000 + frameSequence - 8) * 1_000,
  startAtUnixUs: (12_000 + frameSequence) * 1_000,
  durationMs: 180,
  documentTimelineBridge: {
    producer: "display-callback-wall-bridge",
    clock: "unix-wall",
    callbackObservedAtUnixUs: (12_000 + frameSequence - 8) * 1_000,
    startAtUnixUs: (12_000 + frameSequence) * 1_000,
  },
});

const acceptance = (
  receipt: LayoutPresentationCandidate,
  status: "accepted" | "missed",
) => ({
  status,
  receipt,
  acceptedAtUnixUs: receipt.startAtUnixUs - (status === "accepted" ? 1_000 : -1_000),
  remainingLeadMs: status === "accepted" ? 1 : -1,
});

function participant(id: string, log: string[]): LayoutPresentationCandidateParticipant {
  return {
    id,
    prepare: vi.fn(async (transactionId) => ({
      id,
      transactionId,
      arm: vi.fn(async (receipt) => {
        log.push(`arm:${id}:${receipt.frameSequence}`);
      }),
      disarm: vi.fn((receipt) => {
        log.push(`disarm:${id}:${receipt.frameSequence}`);
      }),
      release: vi.fn(async (receipt) => {
        log.push(`release:${id}:${receipt.frameSequence}`);
      }),
      rollback: vi.fn(async (receipt) => {
        log.push(`rollback:${id}:${receipt.frameSequence}`);
      }),
      cancel: vi.fn(() => log.push(`cancel:${id}`)),
    })),
  };
}

describe("layout presentation candidate coordinator", () => {
  it("reserves a display candidate only after closing the participant prerequisite", async () => {
    const log: string[] = [];
    const receipt = candidate("layout-ready-before-reserve", 6);
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async () => {
        log.push("reserve");
        return receipt;
      },
      acceptCandidate: async (value) => acceptance(value, "accepted"),
      maxCandidateAttempts: 2,
    });
    const readyParticipant: LayoutPresentationCandidateParticipant = {
      id: "dom",
      async prepare(transactionId) {
        return {
          id: "dom",
          transactionId,
          ready: async () => { log.push("ready"); },
          arm: async () => { log.push("arm"); },
          disarm: () => {},
          release: async () => { log.push("release"); },
          rollback: async () => {},
          cancel: () => {},
        };
      },
    };
    const prepared = await coordinator.prepare({
      transactionId: receipt.transactionId,
      participants: [readyParticipant],
    });
    await prepared.start();
    expect(log).toEqual(["ready", "reserve", "arm", "release"]);
  });

  it("returns the reservation without waiting for the installation IPC response so layout preparation continues", async () => {
    const receipt = candidate("layout-installing-first", 7);
    let finishInstall!: () => void;
    const installGate = new Promise<void>((resolve) => { finishInstall = resolve; });
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async () => receipt,
      installCandidate: async (transactionId) => {
        await installGate;
        return {
          transactionId,
          producer: "display-callback-installation" as const,
          clock: "unix-anchored-monotonic" as const,
          sourceGeneration: receipt.sourceGeneration,
          commandReceivedAtUnixUs: receipt.commandReceivedAtUnixUs,
          installedAtUnixUs: receipt.installedAtUnixUs,
        };
      },
      readCandidate: async () => receipt,
      acceptCandidate: async (value) => acceptance(value, "accepted"),
      maxCandidateAttempts: 2,
    });

    const reservation = coordinator.reserveInstalling(receipt.transactionId);
    let settled = false;
    void reservation.outcome.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishInstall();
    await expect(reservation.outcome).resolves.toEqual({ status: "fulfilled", candidate: receipt });
  });

  it("opens the callback read after the first candidate's native installation ACK, independent of owner preparation", async () => {
    const log: string[] = [];
    const receipt = candidate("layout-installed-first", 8);
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async () => receipt,
      installCandidate: async (transactionId) => {
        log.push(`install:${transactionId}`);
        return {
          transactionId,
          producer: "display-callback-installation" as const,
          clock: "unix-anchored-monotonic" as const,
          sourceGeneration: receipt.sourceGeneration,
          commandReceivedAtUnixUs: receipt.commandReceivedAtUnixUs,
          installedAtUnixUs: receipt.installedAtUnixUs,
        };
      },
      readCandidate: async (installation) => {
        log.push(`read:${installation.transactionId}`);
        return receipt;
      },
      acceptCandidate: async (value) => acceptance(value, "accepted"),
      maxCandidateAttempts: 2,
    });

    const reservation = await coordinator.reserveInstalled(receipt.transactionId);
    expect(log).toEqual(["install:layout-installed-first", "read:layout-installed-first"]);
    await expect(reservation.outcome).resolves.toEqual({ status: "fulfilled", candidate: receipt });
  });

  it("opens only the callback read from the exact receipt installed with the pane staging", async () => {
    const log: string[] = [];
    const receipt = candidate("layout-combined-install", 18);
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async () => receipt,
      readCandidate: async (installation) => {
        log.push(`read:${installation.transactionId}`);
        return receipt;
      },
      acceptCandidate: async (value) => acceptance(value, "accepted"),
      maxCandidateAttempts: 2,
    });

    const reservation = coordinator.reserveInstallation({
      transactionId: receipt.transactionId,
      producer: "display-callback-installation",
      clock: "unix-anchored-monotonic",
      sourceGeneration: receipt.sourceGeneration,
      commandReceivedAtUnixUs: receipt.commandReceivedAtUnixUs,
      installedAtUnixUs: receipt.installedAtUnixUs,
    });
    expect(log).toEqual(["read:layout-combined-install"]);
    await expect(reservation.outcome).resolves.toEqual({ status: "fulfilled", candidate: receipt });
  });

  it("discards the exact transaction after installation completes when a candidate reserved before the owner decision is promoted to snap", async () => {
    let finishReserve!: (value: LayoutPresentationCandidate) => void;
    const reservePending = new Promise<LayoutPresentationCandidate>((resolve) => {
      finishReserve = resolve;
    });
    const cancelCandidate = vi.fn(async (_transactionId: string) => {});
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: () => reservePending,
      cancelCandidate,
      acceptCandidate: async (value) => acceptance(value, "accepted"),
      maxCandidateAttempts: 2,
    });

    const reservation = coordinator.reserve("layout-snap-promotion");
    const cancelled = reservation.cancel();
    expect(cancelCandidate).not.toHaveBeenCalled();
    finishReserve(candidate("layout-snap-promotion", 9));
    await cancelled;

    expect(cancelCandidate).toHaveBeenCalledOnce();
    expect(cancelCandidate).toHaveBeenCalledWith("layout-snap-promotion");
  });

  it("overlaps participant prepare with the first display candidate reservation and does not re-reserve the same candidate at start", async () => {
    const log: string[] = [];
    let finishPrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => { finishPrepare = resolve; });
    const receipt = candidate("layout-prefetch", 10);
    const reserveCandidate = vi.fn(async (transactionId: string) => {
      log.push("reserve");
      return { ...receipt, transactionId };
    });
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate,
      acceptCandidate: async (value) => acceptance(value, "accepted"),
      maxCandidateAttempts: 2,
    });
    const delegate: LayoutPresentationCandidateParticipant = participant("dom", log);
    const slowParticipant: LayoutPresentationCandidateParticipant = {
      id: "dom",
      async prepare(transactionId) {
        log.push("prepare");
        await prepareGate;
        return delegate.prepare(transactionId);
      },
    };
    const firstReservation = coordinator.reserve(receipt.transactionId);
    const preparing = coordinator.prepare({
      transactionId: receipt.transactionId,
      participants: [slowParticipant],
      firstReservation,
    });

    expect(log).toEqual(["reserve", "prepare"]);
    finishPrepare();
    const prepared = await preparing;
    await expect(prepared.start()).resolves.toEqual(receipt);
    expect(reserveCandidate).toHaveBeenCalledTimes(1);
  });

  it("preserves in the attempt the exact unix-us cost from the renderer participant arm start to the ACK", async () => {
    const receipt = candidate("layout-arm-cost", 11);
    let now = receipt.callbackObservedAtUnixUs + 2_000;
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async () => receipt,
      acceptCandidate: async (value) => acceptance(value, "accepted"),
      maxCandidateAttempts: 2,
      nowUnixUs: () => {
        const value = now;
        now += 4_250;
        return value;
      },
    });
    const prepared = await coordinator.prepare({
      transactionId: receipt.transactionId,
      participants: [participant("dom", [])],
    });

    await prepared.start();
    expect(prepared.candidateAttempts).toMatchObject([{
      armClock: "unix-anchored-monotonic",
      armStartedAtUnixUs: receipt.callbackObservedAtUnixUs + 2_000,
      armCompletedAtUnixUs: receipt.callbackObservedAtUnixUs + 6_250,
      armDurationUs: 4_250,
    }]);
  });

  it("verifies the native candidate order — command received, main-thread installation, display callback — with the exact producer receipt", async () => {
    const malformed = {
      ...candidate("layout-install-order", 11),
      commandReceivedAtUnixUs: 12_005_000,
      installedAtUnixUs: 12_004_000,
    } as LayoutPresentationCandidate;
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async () => malformed,
      acceptCandidate: async (value) => acceptance(value, "accepted"),
      maxCandidateAttempts: 2,
    });
    const prepared = await coordinator.prepare({
      transactionId: malformed.transactionId,
      participants: [participant("dom", [])],
    });

    await expect(prepared.start()).rejects.toThrow(
      "layout presentation candidate identity is invalid: layout-install-order",
    );
  });

  it("does not compare the native callback epoch with the renderer arm clock raw and preserves only the renderer-internal arm cost", async () => {
    const receipt = candidate("layout-split-clock", 12);
    let now = receipt.callbackObservedAtUnixUs - 5_000;
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async () => receipt,
      acceptCandidate: async (value) => acceptance(value, "accepted"),
      maxCandidateAttempts: 2,
      nowUnixUs: () => {
        now += 2_000;
        return now;
      },
    });
    const prepared = await coordinator.prepare({
      transactionId: receipt.transactionId,
      participants: [participant("dom", [])],
    });

    await expect(prepared.start()).resolves.toEqual(receipt);
    expect(prepared.candidateAttempts).toMatchObject([{
      armClock: "unix-anchored-monotonic",
      armStartedAtUnixUs: receipt.callbackObservedAtUnixUs - 3_000,
      armCompletedAtUnixUs: receipt.callbackObservedAtUnixUs - 1_000,
      armDurationUs: 2_000,
    }]);
    expect(prepared.candidateAttempts[0]).not.toHaveProperty("callbackToArmUs");
    expect(prepared.candidateAttempts[0]).not.toHaveProperty("remainingLeadAtArmMs");
  });

  it("accepts the same future display candidate only after the exact arm ACK from the DOM and every surface", async () => {
    const log: string[] = [];
    const reserveCandidate = vi.fn(async (transactionId: string) => {
      log.push("reserve:11");
      return candidate(transactionId, 11);
    });
    const acceptCandidate = vi.fn(async (receipt: LayoutPresentationCandidate) => {
      log.push(`accept:${receipt.frameSequence}`);
      return acceptance(receipt, "accepted");
    });
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate,
      acceptCandidate,
      maxCandidateAttempts: 2,
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-1",
      participants: [participant("dom", log), participant("native", log)],
    });

    await expect(prepared.start()).resolves.toEqual(candidate("layout-1", 11));
    expect(log).toEqual([
      "reserve:11",
      "arm:dom:11",
      "arm:native:11",
      "accept:11",
      "release:dom:11",
      "release:native:11",
    ]);
  });

  it("disarms every missed candidate and uses the next callback candidate without releasing any surface first", async () => {
    const log: string[] = [];
    let sequence = 20;
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async (transactionId) => candidate(transactionId, ++sequence),
      acceptCandidate: async (receipt) => {
        log.push(`accept:${receipt.frameSequence}`);
        return receipt.frameSequence === 21
          ? acceptance(receipt, "missed")
          : acceptance(receipt, "accepted");
      },
      maxCandidateAttempts: 2,
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-2",
      participants: [participant("dom", log), participant("native", log)],
    });

    await expect(prepared.start()).resolves.toEqual(candidate("layout-2", 22));
    expect(log).toEqual([
      "arm:dom:21", "arm:native:21", "accept:21",
      "disarm:dom:21", "disarm:native:21",
      "arm:dom:22", "arm:native:22", "accept:22",
      "release:dom:22", "release:native:22",
    ]);
    expect(log.slice(0, log.indexOf("accept:22")).some((entry) => entry.startsWith("release:")))
      .toBe(false);
  });

  it("after the arm ACK the producer marks a first candidate with a -2.955ms lead as missed and releases only the second candidate", async () => {
    const log: string[] = [];
    let reserveCount = 0;
    const first = {
      ...candidate("layout-actual", 1),
      callbackObservedAtUnixMs: 1_786_296_563_668.712,
      startAtUnixUs: 1_786_296_563_677_045,
    };
    const second = {
      ...candidate("layout-actual", 2),
      callbackObservedAtUnixMs: 1_786_296_563_685,
      startAtUnixUs: 1_786_296_563_693_333,
    };
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async () => (++reserveCount === 1 ? first : second),
      acceptCandidate: async (receipt) => {
        log.push(`accept:${receipt.frameSequence}`);
        return receipt.frameSequence === 1
          ? { status: "missed", receipt, acceptedAtUnixUs: 1_786_296_563_680_000, remainingLeadMs: -2.955 }
          : { status: "accepted", receipt, acceptedAtUnixUs: 1_786_296_563_692_000, remainingLeadMs: 1.333 };
      },
      maxCandidateAttempts: 2,
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-actual",
      participants: [participant("dom-layout", log), participant("tauri-native-layout", log)],
    });

    await expect(prepared.start()).resolves.toEqual(second);
    expect(reserveCount).toBe(2);
    expect(prepared.candidateAttempts).toMatchObject([
      {
        attempt: 1,
        armAcknowledgedParticipantIds: ["dom-layout", "tauri-native-layout"],
        armFailures: [],
        acceptance: "missed",
        remainingLeadMs: -2.955,
        disarmedParticipantIds: ["dom-layout", "tauri-native-layout"],
        releasedParticipantIds: [],
      },
      {
        attempt: 2,
        armAcknowledgedParticipantIds: ["dom-layout", "tauri-native-layout"],
        armFailures: [],
        acceptance: "accepted",
        remainingLeadMs: 1.333,
        disarmedParticipantIds: [],
        releasedParticipantIds: ["dom-layout", "tauri-native-layout"],
      },
    ]);
    expect(log).toEqual([
      "arm:dom-layout:1", "arm:tauri-native-layout:1", "accept:1",
      "disarm:dom-layout:1", "disarm:tauri-native-layout:1",
      "arm:dom-layout:2", "arm:tauri-native-layout:2", "accept:2",
      "release:dom-layout:2", "release:tauri-native-layout:2",
    ]);
  });

  it("cancels the whole staging when every finite candidate is missed", async () => {
    const log: string[] = [];
    let sequence = 30;
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async (transactionId) => candidate(transactionId, ++sequence),
      acceptCandidate: async (receipt) => acceptance(receipt, "missed"),
      maxCandidateAttempts: 2,
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-3",
      participants: [participant("dom", log), participant("native", log)],
    });

    await expect(prepared.start()).rejects.toMatchObject({
      message: "display candidate missed: layout-3/2",
      transactionId: "layout-3",
      terminalStatus: "candidates-exhausted",
      candidateAttempts: [
        {
          attempt: 1,
          candidate: candidate("layout-3", 31),
          armAcknowledgedParticipantIds: ["dom", "native"],
          acceptance: "missed",
          disarmedParticipantIds: ["dom", "native"],
        },
        {
          attempt: 2,
          candidate: candidate("layout-3", 32),
          armAcknowledgedParticipantIds: ["dom", "native"],
          acceptance: "missed",
          disarmedParticipantIds: ["dom", "native"],
        },
      ],
    });
    expect(log).toEqual([
      "arm:dom:31", "arm:native:31", "disarm:dom:31", "disarm:native:31",
      "arm:dom:32", "arm:native:32", "disarm:dom:32", "disarm:native:32",
      "cancel:dom", "cancel:native",
    ]);
  });

  it("preserves the success ACK, the failed owner and the cleanup of an arm failure in the bounded candidate ledger", async () => {
    const log: string[] = [];
    const dom = participant("dom", log);
    const native = participant("native", log);
    const nativePrepare = native.prepare;
    native.prepare = vi.fn(async (transactionId) => ({
      ...await nativePrepare(transactionId),
      arm: vi.fn(async (receipt) => {
        log.push(`arm:native:${receipt.frameSequence}`);
        throw new Error("native arm rejected");
      }),
    }));
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async (transactionId) => candidate(transactionId, 61),
      acceptCandidate: vi.fn(),
      maxCandidateAttempts: 2,
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-6",
      participants: [dom, native],
    });

    await expect(prepared.start()).rejects.toMatchObject({
      transactionId: "layout-6",
      terminalStatus: "arm-failed",
      candidateAttempts: [{
        attempt: 1,
        candidate: candidate("layout-6", 61),
        armAcknowledgedParticipantIds: ["dom"],
        armFailures: [{ participantId: "native", error: "native arm rejected" }],
        disarmedParticipantIds: ["dom", "native"],
      }],
    });
    expect(log).toEqual([
      "arm:dom:61", "arm:native:61",
      "disarm:dom:61", "disarm:native:61",
      "cancel:dom", "cancel:native",
    ]);
  });

  it("preserves participant arm diagnostics in the same failure ledger as the candidate callback and start", async () => {
    const log: string[] = [];
    const dom = participant("dom-layout", log);
    const prepare = dom.prepare;
    const diagnostic = {
      kind: "dom-animation-arm",
      expectedDocumentStartTime: 125.5,
      observedAtUnixMs: 1_100,
      remainingLeadMs: 25.5,
      animations: [{
        animationName: "rail-flip-x",
        startTime: 124,
        currentTime: 0,
        playState: "paused",
      }],
    };
    dom.prepare = vi.fn(async (transactionId) => ({
      ...await prepare(transactionId),
      arm: vi.fn(async () => {
        throw Object.assign(new Error("DOM arm mismatch"), { diagnostic });
      }),
    }));
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async (transactionId) => candidate(transactionId, 62),
      acceptCandidate: vi.fn(),
      maxCandidateAttempts: 2,
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-dom-diagnostic",
      participants: [dom],
    });

    await expect(prepared.start()).rejects.toMatchObject({
      terminalStatus: "arm-failed",
      candidateAttempts: [{
        candidate: expect.objectContaining({
          callbackObservedAtUnixMs: expect.any(Number),
          startAtUnixUs: expect.any(Number),
        }),
        armFailures: [{
          participantId: "dom-layout",
          error: "DOM arm mismatch",
          diagnostic,
        }],
      }],
    });
  });

  it("disarms every armed participant on an accept IPC failure and preserves the cleanup in the ledger", async () => {
    const log: string[] = [];
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async (transactionId) => candidate(transactionId, 71),
      acceptCandidate: async () => { throw new Error("accept channel closed"); },
      maxCandidateAttempts: 2,
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-7",
      participants: [participant("dom", log), participant("native", log)],
    });

    await expect(prepared.start()).rejects.toMatchObject({
      transactionId: "layout-7",
      terminalStatus: "accept-failed",
      candidateAttempts: [{
        attempt: 1,
        candidate: candidate("layout-7", 71),
        armAcknowledgedParticipantIds: ["dom", "native"],
        disarmedParticipantIds: ["dom", "native"],
      }],
    });
    expect(log).toEqual([
      "arm:dom:71", "arm:native:71",
      "disarm:dom:71", "disarm:native:71",
      "cancel:dom", "cancel:native",
    ]);
  });

  it("does not adopt an accept receipt whose identity differs from the reserved candidate and cancels the whole staging", async () => {
    const log: string[] = [];
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async (transactionId) => candidate(transactionId, 41),
      acceptCandidate: async (receipt) => ({
        ...acceptance(receipt, "accepted"),
        receipt: { ...receipt, frameSequence: 42 },
      }),
      maxCandidateAttempts: 2,
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-4",
      participants: [participant("dom", log), participant("native", log)],
    });

    await expect(prepared.start()).rejects.toThrow("candidate identity changed: layout-4");
    expect(log).toEqual([
      "arm:dom:41", "arm:native:41",
      "disarm:dom:41", "disarm:native:41",
      "cancel:dom", "cancel:native",
    ]);
  });

  it("rolls back every participant and cancels the staging when part of the accepted candidate release fails", async () => {
    const log: string[] = [];
    const first = participant("dom", log);
    const second = participant("native", log);
    const originalPrepare = second.prepare;
    second.prepare = vi.fn(async (transactionId) => {
      const prepared = await originalPrepare(transactionId);
      return {
        ...prepared,
        release: vi.fn(async (receipt) => {
          log.push(`release:native:${receipt.frameSequence}`);
          throw new Error("native release rejected");
        }),
      };
    });
    const coordinator = createLayoutPresentationCandidateCoordinator({
      reserveCandidate: async (transactionId) => candidate(transactionId, 51),
      acceptCandidate: async (receipt) => acceptance(receipt, "accepted"),
      maxCandidateAttempts: 2,
    });
    const prepared = await coordinator.prepare({
      transactionId: "layout-5",
      participants: [first, second],
    });

    await expect(prepared.start()).rejects.toThrow("native release rejected");
    expect(log).toEqual([
      "arm:dom:51", "arm:native:51",
      "release:dom:51", "release:native:51",
      "rollback:dom:51", "rollback:native:51",
      "cancel:dom", "cancel:native",
    ]);
  });
});
