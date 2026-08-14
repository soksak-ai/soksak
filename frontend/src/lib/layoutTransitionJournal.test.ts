import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutTransitionHostForTest,
  LayoutProjectionCommitFailure,
  prepareLayoutMove,
  prepareLayoutChange,
  registerLayoutTransitionHost,
} from "./layoutTransitionHost";
import {
  __resetLayoutTransitionJournalForTest,
  declareLayoutCause,
  layoutTransitionJournal,
  onLayoutTransitionJournal,
} from "./layoutTransitionJournal";
import * as layoutTransitionJournalApi from "./layoutTransitionJournal";
import type { LayoutPresentationStart } from "./layoutPresentationCoordinator";
import type { LayoutPresentationCandidateParticipant } from "./layoutPresentationCandidateCoordinator";
import { LayoutPresentationCandidateFailure } from "./layoutPresentationCandidateCoordinator";

const buildPrepared = (
  identity: { transactionId: string },
  options: {
    mode?: "glide" | "snap";
    start?: () => Promise<LayoutPresentationStart | null>;
    commit?: () => Promise<void>;
    cancel?: () => void;
    stagedTargets?: readonly string[];
    preparation?: Readonly<{
      producer: "layout-adapter";
      clock: "unix-anchored-monotonic";
      stages: readonly Readonly<{
        id: string;
        startedAtUnixMs: number;
        completedAtUnixMs: number;
        status: "prepared";
      }>[];
    }>;
  } = {},
) => ({
  transactionId: identity.transactionId,
  mode: options.mode ?? "glide",
  requiresSharedStart: Boolean(options.start),
  stagedTargets: options.stagedTargets ?? [],
  ...(options.preparation ? { preparation: options.preparation } : {}),
  start: options.start ?? (async () => null),
  commit: options.commit ?? (async () => {}),
  cancel: options.cancel ?? (() => {}),
});

type LayoutTransactionWaitApi = {
  waitForLayoutTransaction: (input: {
    causeTraceId: string;
    afterSequence: number;
    timeoutMs: number;
  }) => Promise<{
    causeStatus: "exact";
    entry: { transactionId: string; phase: string; causeTraceId?: string; sequence: number };
  }>;
  __layoutTransitionJournalListenerCountForTest: () => number;
};

function transactionWaitApi(): LayoutTransactionWaitApi {
  const api = layoutTransitionJournalApi as unknown as Partial<LayoutTransactionWaitApi>;
  if (typeof api.waitForLayoutTransaction !== "function") {
    throw new Error("layout transaction terminal wait API is not implemented");
  }
  if (typeof api.__layoutTransitionJournalListenerCountForTest !== "function") {
    throw new Error("layout transaction wait listener audit is not implemented");
  }
  return api as LayoutTransactionWaitApi;
}

type LayoutTransactionSettlementApi = {
  bindLayoutTransactionSettlement: (
    transactionId: string,
    receipt: { ownerKey: string; revision: number },
  ) => void;
  finishLayoutTransactionSettlement: (
    transactionId: string,
    receipt: { ownerKey: string; revision: number; status: "settled" | "failed" | "cancelled" },
  ) => void;
};

function transactionSettlementApi(): LayoutTransactionSettlementApi {
  const api = layoutTransitionJournalApi as unknown as Partial<LayoutTransactionSettlementApi>;
  if (typeof api.bindLayoutTransactionSettlement !== "function"
    || typeof api.finishLayoutTransactionSettlement !== "function") {
    throw new Error("layout transaction settlement revision API is not implemented");
  }
  return api as LayoutTransactionSettlementApi;
}

describe("layout transition public journal", () => {
  beforeEach(() => {
    __resetLayoutTransitionHostForTest();
    __resetLayoutTransitionJournalForTest();
  });

  it("restore revision preserves pending→settled with the same identity as the exact transaction terminal", async () => {
    registerLayoutTransitionHost({
      prepareChange: async (_change, identity) => ({
        ...buildPrepared(identity, { mode: "snap" }),
        commit: async () => ({
          transactionId: identity.transactionId,
          producer: "layout-adapter",
          targets: [],
        }),
      } as never),
    });
    const prepared = await prepareLayoutMove([]);
    transactionSettlementApi().bindLayoutTransactionSettlement(prepared.transactionId, {
      ownerKey: "t1",
      revision: 8,
    });
    await prepared.commit();
    expect(layoutTransitionJournal()[0]).toMatchObject({
      transactionId: "layout-1",
      phase: "committed",
      settlement: { ownerKey: "t1", revision: 8, status: "pending" },
    });

    transactionSettlementApi().finishLayoutTransactionSettlement(prepared.transactionId, {
      ownerKey: "t1",
      revision: 8,
      status: "settled",
    });
    expect(layoutTransitionJournal()[0]).toMatchObject({
      settlement: { ownerKey: "t1", revision: 8, status: "settled" },
    });
  });

  it("a DOM-only transaction exposes id, move, prepare, and commit too", async () => {
    const prepared = await prepareLayoutMove([{ viewId: "v1", dx: 320 }]);
    expect(layoutTransitionJournal()).toEqual([
      expect.objectContaining({
        transactionId: "layout-1",
        mode: "glide",
        phase: "prepared",
        moves: [{ viewId: "v1", dx: 320 }],
      }),
    ]);
    await prepared.commit();
    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({ phase: "committed" }));
  });

  it("exposes identity, cause, and move as preparing immediately while the adapter ACK is outstanding", async () => {
    let resolvePrepare!: (prepared: ReturnType<typeof buildPrepared>) => void;
    registerLayoutTransitionHost({
      prepareChange: (_moves, identity) => new Promise((resolve) => {
        resolvePrepare = () => resolve(buildPrepared(identity, {
          mode: "glide",
          stagedTargets: ["pane:p-left"],
        }));
      }),
    });
    declareLayoutCause("cause-preparing");

    const pending = prepareLayoutChange({
      moves: [{ viewId: "v1", dx: 320 }],
      projectionParticipants: [],
      panePresentationTargets: [{ viewId: "v1" }],
      paneSettlementParticipants: [{ viewId: "sibling" }],
    });

    expect(layoutTransitionJournal()).toEqual([{
      transactionId: "layout-1",
      clock: "unix-anchored-monotonic",
      causeTraceId: "cause-preparing",
      sequence: 1,
      phase: "preparing",
      mode: null,
      settlement: null,
      openedAtUnixMs: expect.any(Number),
      stagedTargetsStatus: "pending",
      stagedTargets: null,
      panePresentationTargets: [{ viewId: "v1" }],
      paneSettlementParticipants: [{ viewId: "sibling" }],
      moves: [{ viewId: "v1", dx: 320 }],
    }]);

    resolvePrepare(buildPrepared({ transactionId: "layout-1" }));
    await pending;
    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
      transactionId: "layout-1",
      sequence: 1,
      phase: "prepared",
      mode: "glide",
      preparedAtUnixMs: expect.any(Number),
      stagedTargetsStatus: "declared",
      stagedTargets: ["pane:p-left"],
    }));
  });

  it("an adapter prepare reject is not lost as an off-journal rejection but closed as a failed terminal", async () => {
    registerLayoutTransitionHost({
      prepareChange: async () => { throw new Error("pane stage rejected"); },
    });
    declareLayoutCause("cause-stage-failed");

    await expect(prepareLayoutMove([{ viewId: "v1", dx: 320 }]))
      .rejects.toThrow("pane stage rejected");
    expect(layoutTransitionJournal()).toEqual([expect.objectContaining({
      transactionId: "layout-1",
      causeTraceId: "cause-stage-failed",
      sequence: 1,
      phase: "failed",
      mode: null,
      stagedTargetsStatus: "pending",
      stagedTargets: null,
      failure: "pane stage rejected",
      closedAtUnixMs: expect.any(Number),
    })]);
  });

  it("preserves the adapter preparation stage receipt in the exact transaction journal", async () => {
    const preparation = {
      producer: "layout-adapter" as const,
      clock: "unix-anchored-monotonic" as const,
      stages: [
        { id: "owner-barrier", startedAtUnixMs: 1_000, completedAtUnixMs: 1_004, status: "prepared" as const },
        { id: "settlement", startedAtUnixMs: 1_004, completedAtUnixMs: 1_032, status: "prepared" as const },
      ],
    };
    registerLayoutTransitionHost({
      prepareChange: async (_change, identity) => buildPrepared(identity, { preparation }),
    });

    await prepareLayoutMove([{ viewId: "v1", dx: 320 }]);

    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
      transactionId: "layout-1",
      phase: "prepared",
      preparation,
    }));
  });

  it("concurrent adapter prepares do not mix identity, cause, and target regardless of resolve order", async () => {
    const releases = new Map<string, (prepared: ReturnType<typeof buildPrepared>) => void>();
    registerLayoutTransitionHost({
      prepareChange: (_moves, identity) => new Promise((resolve) => {
        releases.set(identity.transactionId, resolve);
      }),
    });
    declareLayoutCause("cause-first");
    const first = prepareLayoutMove([{ viewId: "v1", dx: 120 }]);
    declareLayoutCause("cause-second");
    const second = prepareLayoutMove([{ viewId: "v2", dx: -120 }]);
    expect(layoutTransitionJournal().map((entry) => ({
      id: entry.transactionId,
      cause: entry.causeTraceId,
      phase: entry.phase,
    }))).toEqual([
      { id: "layout-1", cause: "cause-first", phase: "preparing" },
      { id: "layout-2", cause: "cause-second", phase: "preparing" },
    ]);

    releases.get("layout-2")!(buildPrepared({ transactionId: "layout-2" }, {
      mode: "snap",
      stagedTargets: ["direct:second"],
    }));
    await second;
    releases.get("layout-1")!(buildPrepared({ transactionId: "layout-1" }, {
      mode: "glide",
      stagedTargets: ["pane:first"],
    }));
    await first;

    expect(layoutTransitionJournal().map((entry) => ({
      id: entry.transactionId,
      cause: entry.causeTraceId,
      mode: entry.mode,
      targets: entry.stagedTargets,
    }))).toEqual([
      { id: "layout-1", cause: "cause-first", mode: "glide", targets: ["pane:first"] },
      { id: "layout-2", cause: "cause-second", mode: "snap", targets: ["direct:second"] },
    ]);
  });

  it("terminal history reclamation never evicts a transaction still preparing", async () => {
    let resolveActive!: (prepared: ReturnType<typeof buildPrepared>) => void;
    registerLayoutTransitionHost({
      prepareChange: (_moves, identity) => new Promise((resolve) => {
        resolveActive = () => resolve(buildPrepared(identity));
      }),
    });
    declareLayoutCause("cause-active");
    const active = prepareLayoutMove([{ viewId: "active", dx: 160 }]);

    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity),
    });
    for (let index = 0; index < 70; index += 1) {
      const transaction = await prepareLayoutMove([{ viewId: `done-${index}`, dx: 1 }]);
      await transaction.commit();
    }

    expect(layoutTransitionJournal()).toContainEqual(expect.objectContaining({
      transactionId: "layout-1",
      causeTraceId: "cause-active",
      phase: "preparing",
    }));
    resolveActive(buildPrepared({ transactionId: "layout-1" }));
    const prepared = await active;
    await prepared.commit();
    expect(layoutTransitionJournal()).toHaveLength(64);
    const rows = layoutTransitionJournal();
    expect(rows[rows.length - 1]).toEqual(expect.objectContaining({
      transactionId: "layout-71",
      phase: "committed",
    }));
  });

  it("a begin past 16 active transactions does not call the adapter and leaves a failed terminal with the exact cause", async () => {
    const prepareChange = vi.fn(() => new Promise<ReturnType<typeof buildPrepared>>(() => {}));
    registerLayoutTransitionHost({ prepareChange });
    for (let index = 0; index < 16; index += 1) {
      void prepareLayoutMove([{ viewId: `active-${index}`, dx: 1 }]);
    }
    declareLayoutCause("cause-capacity");
    void prepareLayoutMove([{ viewId: "overflow", dx: 1 }]).catch(() => {});

    expect(prepareChange).toHaveBeenCalledTimes(16);
    expect(layoutTransitionJournal()).toContainEqual(expect.objectContaining({
      transactionId: "layout-17",
      causeTraceId: "cause-capacity",
      phase: "failed",
      mode: null,
      stagedTargetsStatus: "pending",
      stagedTargets: null,
      failure: "layout active transaction capacity exceeded: 16",
      closedAtUnixMs: expect.any(Number),
    }));
  });

  it("a prepare reject emits exactly one terminal after preparing and a late bind/fail does not close it twice", async () => {
    const events: unknown[] = [];
    const unsubscribe = onLayoutTransitionJournal((event) => events.push(event));
    registerLayoutTransitionHost({
      prepareChange: async () => { throw new Error("stage rejected once"); },
    });
    try {
      await expect(prepareLayoutMove([{ viewId: "v1", dx: 1 }]))
        .rejects.toThrow("stage rejected once");
      expect(events.map((event) => (event as { type: string }).type)).toEqual([
        "preparing",
        "terminal",
      ]);
      expect(events.filter((event) => (
        (event as { type: string }).type === "terminal"
      ))).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("exposes the native transaction target identity from the direct/pane canonical source instead of guessing from pixels", async () => {
    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity, {
        stagedTargets: ["pane:p-left"],
      }),
    });
    await prepareLayoutMove([{ viewId: "v1", dx: 320 }]);

    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
      stagedTargets: ["pane:p-left"],
    }));
  });

  it("a glide transaction exposes the declared duration a verifier needs to reproduce the same trajectory", async () => {
    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity, {
        mode: "glide",
        start: async () => ({
          transactionId: identity.transactionId,
          producer: "display-callback",
          clock: "unix-anchored-monotonic",
          sourceGeneration: 1,
          frameSequence: 1,
          startAtUnixUs: 1_000,
          durationMs: 340,
          candidateAttempts: [{
            attempt: 1,
            candidate: {
              transactionId: identity.transactionId,
              producer: "display-callback",
              clock: "unix-anchored-monotonic",
              sourceGeneration: 1,
              frameSequence: 1,
              commandReceivedAtUnixUs: 1,
              installedAtUnixUs: 2,
              callbackReceivedAtUnixUs: 9_000_000_000_000_000,
              callbackObservedAtUnixMs: 0.5,
              callbackObservedAtUnixUs: 500,
              startAtUnixUs: 1_000,
              durationMs: 340,
              documentTimelineBridge: {
                producer: "display-callback-wall-bridge",
                clock: "unix-wall",
                callbackObservedAtUnixUs: 500,
                startAtUnixUs: 1_000,
              },
            },
            armAcknowledgedParticipantIds: ["tauri-native-layout", "dom-layout"],
            armFailures: [],
            armClock: "unix-anchored-monotonic",
            armStartedAtUnixUs: 600,
            armCompletedAtUnixUs: 800,
            armDurationUs: 200,
            acceptance: "accepted",
            acceptedAtUnixUs: 900,
            remainingLeadMs: 0.1,
            disarmedParticipantIds: [],
            disarmFailures: [],
            releasedParticipantIds: ["tauri-native-layout", "dom-layout"],
            releaseFailures: [],
            rolledBackParticipantIds: [],
            rollbackFailures: [],
          }],
        }),
      }),
    });
    const transaction = await prepareLayoutMove([{ viewId: "v1", dx: 160 }]);
    await transaction.start();
    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
      presentationStart: expect.objectContaining({
        durationMs: 340,
        candidateAttempts: [expect.objectContaining({
          attempt: 1,
          acceptance: "accepted",
          armAcknowledgedParticipantIds: ["tauri-native-layout", "dom-layout"],
          disarmedParticipantIds: [],
          releasedParticipantIds: ["tauri-native-layout", "dom-layout"],
        })],
      }),
    }));
  });

  it("a successful presentationStart without bounded candidateAttempts fails the transaction", async () => {
    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity, {
        start: async () => ({
          transactionId: identity.transactionId,
          producer: "display-callback",
          clock: "unix-anchored-monotonic",
          sourceGeneration: 1,
          frameSequence: 1,
          startAtUnixUs: 1_000,
          durationMs: 180,
        } as never),
      }),
    });
    const transaction = await prepareLayoutMove([{ viewId: "v1", dx: 160 }]);

    await expect(transaction.start()).rejects.toThrow("candidateAttempts");
    expect(layoutTransitionJournal()[0]).toMatchObject({ phase: "failed" });
    expect(layoutTransitionJournal()[0]).not.toHaveProperty("presentationStart");
  });

  it("the journal wrapper passes the exposed DOM candidate participant through to the host start", async () => {
    const start = vi.fn(async () => null);
    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity, { start }),
    });
    const participant = {
      id: "dom-layout",
      prepare: vi.fn(),
    } as unknown as LayoutPresentationCandidateParticipant;
    const transaction = await prepareLayoutMove([{ viewId: "v1", dx: 160 }]);

    await transaction.start(participant);

    expect(start).toHaveBeenCalledWith(participant);
  });

  it("snap leaves the exact projection commit ACK in the terminal journal without a shared start", async () => {
    const start = vi.fn(async () => null);
    const projectionCommit = {
      transactionId: "layout-1",
      producer: "layout-adapter",
      targets: [{
        stagedTarget: "pane:p-left",
        owner: "pane-bounds",
        frame: { x: 12, y: 34, w: 640, h: 480 },
      }],
    };
    registerLayoutTransitionHost({
      prepareChange: async (_change, identity) => ({
        ...buildPrepared(identity, {
          mode: "snap",
          stagedTargets: ["pane:p-left"],
          start,
        }),
        requiresSharedStart: false,
        commit: async () => projectionCommit,
      } as never),
    });
    declareLayoutCause("b01/browser/0/tab-left");

    const transaction = await prepareLayoutMove([]);
    await transaction.commit();
    const receipt = await transactionWaitApi().waitForLayoutTransaction({
      causeTraceId: "b01/browser/0/tab-left",
      afterSequence: 0,
      timeoutMs: 100,
    });

    expect(start).not.toHaveBeenCalled();
    expect(receipt.entry).toMatchObject({
      phase: "committed",
      mode: "snap",
      stagedTargets: ["pane:p-left"],
      projectionCommit,
    });
    expect(receipt.entry).not.toHaveProperty("presentationStart");
  });

  it("a snap commit failure preserves the raw pane-bounds ACK inventory in the terminal artifact", async () => {
    const paneBoundsAck = {
      transactionId: "layout-1",
      pane: "pane:p-left",
      targetMemberFrames: [{ label: "browser-left", frame: { x: 0, y: 0, w: 774, h: 549 } }],
      memberPlacements: [{
        label: "browser-left", ownerPane: "pane:p-left", visible: true,
        effectiveAlpha: 1, frame: { x: 0, y: 0, w: 773, h: 549 },
        sourceGeneration: 7, frameSequence: 72,
      }],
    };
    const failure = new LayoutProjectionCommitFailure({
        transactionId: "layout-1",
        stagedTarget: "pane:p-left",
        paneBoundsAck,
    }, new Error("projection target member frame mismatch"));
    registerLayoutTransitionHost({
      prepareChange: async (_change, identity) => ({
        ...buildPrepared(identity, { mode: "snap", stagedTargets: ["pane:p-left"] }),
        requiresSharedStart: false,
        commit: async () => { throw failure; },
      } as never),
    });
    declareLayoutCause("maximize-left");
    const transaction = await prepareLayoutMove([]);

    await expect(transaction.commit()).rejects.toBe(failure);
    expect(layoutTransitionJournal()[0]).toMatchObject({
      phase: "failed",
      mode: "snap",
      projectionFailure: {
        transactionId: "layout-1",
        stagedTarget: "pane:p-left",
        paneBoundsAck,
      },
    });
  });

  it("glide preserves the producer presentationStart as required and holds no projection commit", async () => {
    registerLayoutTransitionHost({
      prepareChange: async (_change, identity) => buildPrepared(identity, {
        mode: "glide",
        stagedTargets: ["pane:p-left"],
        start: async () => {
          const candidate = {
            transactionId: identity.transactionId,
            producer: "display-callback" as const,
            clock: "unix-anchored-monotonic" as const,
            sourceGeneration: 1,
            frameSequence: 1,
            commandReceivedAtUnixUs: 1,
            installedAtUnixUs: 2,
            callbackReceivedAtUnixUs: 9_000_000_000_000_000,
            callbackObservedAtUnixMs: 1,
            callbackObservedAtUnixUs: 1_000,
            startAtUnixUs: 2_000,
            durationMs: 180,
            documentTimelineBridge: {
              producer: "display-callback-wall-bridge" as const,
              clock: "unix-wall" as const,
              callbackObservedAtUnixUs: 1_000,
              startAtUnixUs: 2_000,
            },
          };
          return {
            ...candidate,
            candidateAttempts: [{
              attempt: 1,
              candidate,
              armAcknowledgedParticipantIds: ["tauri-native-layout", "dom-layout"],
              armFailures: [],
              armClock: "unix-anchored-monotonic",
              armStartedAtUnixUs: 1_200,
              armCompletedAtUnixUs: 1_500,
              armDurationUs: 300,
              acceptance: "accepted" as const,
              acceptedAtUnixUs: 1_500,
              remainingLeadMs: 0.5,
              disarmedParticipantIds: [],
              disarmFailures: [],
              releasedParticipantIds: ["tauri-native-layout", "dom-layout"],
              releaseFailures: [],
              rolledBackParticipantIds: [],
              rollbackFailures: [],
            }],
          };
        },
      }),
    });

    const transaction = await prepareLayoutMove([{ viewId: "left", dx: 160 }]);
    await transaction.start({ id: "dom-layout", prepare: vi.fn() } as never);
    await transaction.commit();

    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
      phase: "committed",
      mode: "glide",
      presentationStart: expect.objectContaining({ transactionId: "layout-1" }),
    }));
    expect(layoutTransitionJournal()[0]).not.toHaveProperty("projectionCommit");
  });

  it("closes the adapter commit/cancel exactly once and records the order", async () => {
    const commit = vi.fn(async () => {});
    const cancel = vi.fn();
    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity, { commit, cancel }),
    });
    const first = await prepareLayoutMove([{ viewId: "v1", dx: -100 }]);
    const second = await prepareLayoutMove([{ viewId: "v2", dx: 100 }]);
    expect(layoutTransitionJournal().map((row) => row.transactionId)).toEqual(["layout-1", "layout-2"]);
    await first.commit();
    await first.commit();
    second.cancel();
    second.cancel();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(layoutTransitionJournal().map((row) => row.phase)).toEqual(["committed", "cancelled"]);
  });

  it("emits the DOM commit event with the transaction synchronously, before the surface ACK", async () => {
    let releaseSurfaceAck!: () => void;
    const surfaceAck = new Promise<void>((resolve) => { releaseSurfaceAck = resolve; });
    const commit = vi.fn(() => surfaceAck);
    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity, { commit, cancel: vi.fn() }),
    });
    const events: unknown[] = [];
    const unsubscribe = onLayoutTransitionJournal((event) => events.push(event));
    try {
      const prepared = await prepareLayoutMove([{ viewId: "v1", dx: 160 }]);
      const committing = prepared.commit();

      expect(commit).toHaveBeenCalledOnce();
      expect(events).toEqual([
        expect.objectContaining({
          type: "preparing",
          transactionId: "layout-1",
          sequence: 1,
        }),
        expect.objectContaining({
          type: "prepared",
          transactionId: "layout-1",
          sequence: 1,
          mode: "glide",
        }),
        expect.objectContaining({
          type: "dom-committed",
          transactionId: "layout-1",
          sequence: 1,
          domCommittedAtUnixMs: expect.any(Number),
        }),
      ]);
      expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
        phase: "prepared",
        domCommittedAtUnixMs: (events[2] as { domCommittedAtUnixMs: number }).domCommittedAtUnixMs,
      }));

      releaseSurfaceAck();
      await committing;
      expect(events.filter((event) => (
        (event as { type?: string }).type === "terminal"
      ))).toEqual([expect.objectContaining({
        type: "terminal",
        transactionId: "layout-1",
        phase: "committed",
      })]);
      expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
        phase: "committed",
        domCommittedAtUnixMs: expect.any(Number),
        closedAtUnixMs: expect.any(Number),
      }));
    } finally {
      unsubscribe();
    }
  });

  it("does not close a glide transaction before the shared start resolves", async () => {
    let releaseStart!: (receipt: LayoutPresentationStart) => void;
    const start = new Promise<LayoutPresentationStart>((resolve) => { releaseStart = resolve; });
    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity, {
        mode: "glide",
        start: () => start,
      }),
    });
    const transaction = await prepareLayoutMove([{ viewId: "v1", dx: -160 }]);
    const starting = transaction.start();
    const committing = transaction.commit();
    await Promise.resolve();
    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
      phase: "prepared",
      domCommittedAtUnixMs: expect.any(Number),
    }));
    releaseStart({
      transactionId: "layout-1",
      producer: "display-callback",
      clock: "unix-anchored-monotonic",
      sourceGeneration: 1,
      frameSequence: 1,
      startAtUnixUs: 1_000,
      durationMs: 340,
      candidateAttempts: [{
        attempt: 1,
        candidate: {
          transactionId: "layout-1", producer: "display-callback", clock: "unix-anchored-monotonic",
          sourceGeneration: 1, frameSequence: 1,
          commandReceivedAtUnixUs: 300, installedAtUnixUs: 400,
          callbackReceivedAtUnixUs: 9_000_000_000_000_000,
          callbackObservedAtUnixMs: 0.5,
          callbackObservedAtUnixUs: 500,
          startAtUnixUs: 1_000, durationMs: 340,
          documentTimelineBridge: {
            producer: "display-callback-wall-bridge", clock: "unix-wall",
            callbackObservedAtUnixUs: 500, startAtUnixUs: 1_000,
          },
        },
        armAcknowledgedParticipantIds: ["dom-layout"], armFailures: [],
        armClock: "unix-anchored-monotonic", armStartedAtUnixUs: 600,
        armCompletedAtUnixUs: 800, armDurationUs: 200,
        acceptance: "accepted", acceptedAtUnixUs: 900, remainingLeadMs: 0.1,
        disarmedParticipantIds: [], disarmFailures: [], releasedParticipantIds: ["dom-layout"],
        releaseFailures: [], rolledBackParticipantIds: [], rollbackFailures: [],
      }],
    });
    await starting;
    await committing;
    const row = layoutTransitionJournal()[0]!;
    expect(row).toEqual(expect.objectContaining({
      phase: "committed",
      presentationStart: expect.objectContaining({
        transactionId: "layout-1",
        producer: "display-callback",
        clock: "unix-anchored-monotonic",
        sourceGeneration: 1,
        frameSequence: 1,
        startAtUnixUs: 1_000,
        durationMs: 340,
      }),
    }));
    expect(row).not.toHaveProperty("startAtUnixUs");
    expect(row).not.toHaveProperty("durationMs");
  });

  it("a surface ACK reject is not left in prepared but closed as a failed terminal fact", async () => {
    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity, {
        commit: async () => { throw new Error("surface ACK rejected"); },
        cancel: vi.fn(),
      }),
    });
    const prepared = await prepareLayoutMove([{ viewId: "v1", dx: 160 }]);

    await expect(prepared.commit()).rejects.toThrow("surface ACK rejected");
    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
      phase: "failed",
      domCommittedAtUnixMs: expect.any(Number),
      closedAtUnixMs: expect.any(Number),
      failure: "surface ACK rejected",
    }));
  });

  it("a shared start failure is not covered by cancel but closed as a failed terminal with the candidate attempt ledger", async () => {
    const cancel = vi.fn();
    const candidateAttempts = [{
      attempt: 1,
      candidate: {
        transactionId: "layout-1",
        producer: "display-callback" as const,
        clock: "unix-anchored-monotonic" as const,
        sourceGeneration: 7,
        frameSequence: 31,
        commandReceivedAtUnixUs: 1,
        installedAtUnixUs: 2,
        callbackReceivedAtUnixUs: 9_000_000_000_000_000,
        callbackObservedAtUnixMs: 12_023,
        callbackObservedAtUnixUs: 12_023,
        startAtUnixUs: 12_031,
        durationMs: 180,
        documentTimelineBridge: {
          producer: "display-callback-wall-bridge" as const,
          clock: "unix-wall" as const,
          callbackObservedAtUnixUs: 12_023,
          startAtUnixUs: 12_031,
        },
      },
      armAcknowledgedParticipantIds: ["dom", "native"],
      armClock: "unix-anchored-monotonic" as const,
      armStartedAtUnixUs: 12_024,
      armCompletedAtUnixUs: 12_025,
      armDurationUs: 1,
      armFailures: [{
        participantId: "dom-layout",
        error: "DOM arm mismatch",
        diagnostic: {
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
        },
      }],
      acceptance: "missed" as const,
      disarmedParticipantIds: ["dom", "native"],
      disarmFailures: [],
      releasedParticipantIds: [],
      releaseFailures: [],
      rolledBackParticipantIds: [],
      rollbackFailures: [],
    }];
    const failure = new LayoutPresentationCandidateFailure({
      transactionId: "layout-1",
      terminalStatus: "candidates-exhausted",
      candidateAttempts,
      cause: new Error("display candidate missed: layout-1/2"),
    });
    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity, {
        start: async () => { throw failure; },
        cancel,
      }),
    });
    const prepared = await prepareLayoutMove([{ viewId: "v1", dx: 160 }]);

    await expect(prepared.start()).rejects.toBe(failure);
    prepared.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(layoutTransitionJournal()[0]).toEqual(expect.objectContaining({
      phase: "failed",
      failure: "display candidate missed: layout-1/2",
      presentationFailure: {
        transactionId: "layout-1",
        terminalStatus: "candidates-exhausted",
        candidateAttempts: failure.candidateAttempts,
      },
      closedAtUnixMs: expect.any(Number),
    }));
  });

  it("terminal-ACKs committed and failed transactions created after subscription by cause identity", async () => {
    const { waitForLayoutTransaction } = transactionWaitApi();
    const committedWait = waitForLayoutTransaction({
      causeTraceId: "cause-committed",
      afterSequence: 0,
      timeoutMs: 1_000,
    });
    declareLayoutCause("cause-committed");
    const committed = await prepareLayoutMove([{ viewId: "v1", dx: 160 }]);
    await committed.commit();
    await expect(committedWait).resolves.toEqual({
      causeStatus: "exact",
      entry: expect.objectContaining({
        transactionId: "layout-1",
        causeTraceId: "cause-committed",
        phase: "committed",
      }),
    });

    registerLayoutTransitionHost({
      prepareChange: async (_moves, identity) => buildPrepared(identity, {
        commit: async () => { throw new Error("surface commit rejected"); },
      }),
    });
    const failedWait = waitForLayoutTransaction({
      causeTraceId: "cause-failed",
      afterSequence: 1,
      timeoutMs: 1_000,
    });
    declareLayoutCause("cause-failed");
    const failed = await prepareLayoutMove([{ viewId: "v1", dx: -160 }]);
    await expect(failed.commit()).rejects.toThrow("surface commit rejected");
    await expect(failedWait).resolves.toEqual({
      causeStatus: "exact",
      entry: expect.objectContaining({
        transactionId: "layout-2",
        causeTraceId: "cause-failed",
        phase: "failed",
        failure: "surface commit rejected",
      }),
    });
  });

  it("an already closed transaction snapshot is not missed either, in one atomic boundary with listener installation", async () => {
    const { waitForLayoutTransaction } = transactionWaitApi();
    declareLayoutCause("cause-snapshot");
    const transaction = await prepareLayoutMove([{ viewId: "v1", dx: 80 }]);
    await transaction.commit();

    await expect(waitForLayoutTransaction({
      causeTraceId: "cause-snapshot",
      afterSequence: 0,
      timeoutMs: 1_000,
    })).resolves.toEqual({
      causeStatus: "exact",
      entry: expect.objectContaining({ transactionId: "layout-1", phase: "committed" }),
    });
  });

  it("ignores an old sequence, a different cause, and cause-free transactions and waits for exactly one", async () => {
    const { waitForLayoutTransaction } = transactionWaitApi();
    declareLayoutCause("cause-target");
    const old = await prepareLayoutMove([{ viewId: "old", dx: 1 }]);
    await old.commit();
    declareLayoutCause("cause-other");
    const other = await prepareLayoutMove([{ viewId: "other", dx: 1 }]);
    await other.commit();
    const causeless = await prepareLayoutMove([{ viewId: "causeless", dx: 1 }]);
    await causeless.commit();

    const waiting = waitForLayoutTransaction({
      causeTraceId: "cause-target",
      afterSequence: 1,
      timeoutMs: 1_000,
    });
    declareLayoutCause("cause-target");
    const target = await prepareLayoutMove([{ viewId: "target", dx: 1 }]);
    await target.commit();

    await expect(waiting).resolves.toEqual({
      causeStatus: "exact",
      entry: expect.objectContaining({ transactionId: "layout-4", sequence: 4 }),
    });
  });

  it("two exact causes in the same sequence window are refused as ambiguous instead of picked arbitrarily", async () => {
    const { waitForLayoutTransaction } = transactionWaitApi();
    for (const viewId of ["v1", "v2"]) {
      declareLayoutCause("cause-duplicate");
      const transaction = await prepareLayoutMove([{ viewId, dx: 1 }]);
      await transaction.commit();
    }

    await expect(waitForLayoutTransaction({
      causeTraceId: "cause-duplicate",
      afterSequence: 0,
      timeoutMs: 1_000,
    })).rejects.toThrow(/ambiguous.*cause-duplicate/i);
  });

  it("reclaims the listener exactly after a finite timeout and consumes no later transaction", async () => {
    vi.useFakeTimers();
    try {
      const {
        waitForLayoutTransaction,
        __layoutTransitionJournalListenerCountForTest,
      } = transactionWaitApi();
      const waiting = waitForLayoutTransaction({
        causeTraceId: "cause-timeout",
        afterSequence: 0,
        timeoutMs: 25,
      });
      const rejected = expect(waiting).rejects.toThrow(/timeout.*cause-timeout/i);
      expect(__layoutTransitionJournalListenerCountForTest()).toBe(1);
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(__layoutTransitionJournalListenerCountForTest()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses bad input and an excessive timeout at the API boundary, and reset reclaims pending listeners", async () => {
    const {
      waitForLayoutTransaction,
      __layoutTransitionJournalListenerCountForTest,
    } = transactionWaitApi();
    await expect(waitForLayoutTransaction({
      causeTraceId: undefined as unknown as string,
      afterSequence: 0,
      timeoutMs: 1,
    })).rejects.toThrow(/causeTraceId must be a string/);
    await expect(waitForLayoutTransaction({
      causeTraceId: "bounded",
      afterSequence: 0,
      timeoutMs: 30_001,
    })).rejects.toThrow(/1\.\.30000/);

    void waitForLayoutTransaction({
      causeTraceId: "pending-reset",
      afterSequence: 0,
      timeoutMs: 30_000,
    });
    expect(__layoutTransitionJournalListenerCountForTest()).toBe(1);
    __resetLayoutTransitionJournalForTest();
    expect(__layoutTransitionJournalListenerCountForTest()).toBe(0);
  });

});
