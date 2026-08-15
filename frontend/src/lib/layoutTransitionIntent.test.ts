import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Arrangement } from "./railArrangement";
import type { PreparedLayoutTransition } from "./layoutTransitionHost";
import {
  __resetLayoutTransitionIntentForTest,
  claimLayoutTransitionIntent,
  finishLayoutTransitionIntent,
  layoutTransitionIntentFacts,
  publishLayoutTransitionIntent,
  registerLayoutTransitionIntentHost,
} from "./layoutTransitionIntent";

type Leaf = { id: string };

const arrangement = (station: number, focusId: string): Arrangement<Leaf> => ({
  station,
  cleanLines: [0, 50, 100],
  displayLayout: { type: "leaf", value: { id: focusId } },
  swapped: false,
  cells: [{ id: focusId, rect: { left: station, top: 0, width: 50, height: 100 } }],
  focusId,
  betweenIds: [],
  maximizedId: null,
});

const prepared = (transactionId: string): PreparedLayoutTransition => ({
  transactionId,
  mode: "glide",
  requiresSharedStart: true,
  stagedTargets: [],
  start: async () => null,
  commit: async () => {},
  cancel: vi.fn(),
});

describe("layoutTransitionIntent — adapter prepare ownership before the state publish", () => {
  beforeEach(() => __resetLayoutTransitionIntentForTest());

  it("the call that publishes a revision intent starts the host prepare, and React claims that same promise once", async () => {
    const order: string[] = [];
    const result = prepared("layout-1");
    registerLayoutTransitionIntentHost("workspace-1", {
      prepare: async ({ ownerKey, revision, from, to }) => {
        order.push("prepare");
        expect({ ownerKey, revision, from: from.station, to: to.station }).toEqual({
          ownerKey: "workspace-1",
          revision: 1,
          from: 0,
          to: 50,
        });
        return result;
      },
    });

    expect(publishLayoutTransitionIntent({
      ownerKey: "workspace-1",
      revision: 1,
      from: arrangement(0, "left"),
      to: arrangement(50, "right"),
    })).toBe(true);
    order.push("state-publish");

    const claimed = claimLayoutTransitionIntent("workspace-1", 1);
    expect(order).toEqual(["prepare", "state-publish"]);
    await expect(claimed).resolves.toBe(result);
    expect(claimLayoutTransitionIntent("workspace-1", 1)).toBeNull();
  });

  it("a replaced host and a stale revision do not mix into the next workspace transaction", async () => {
    const old = prepared("layout-old");
    const fresh = prepared("layout-fresh");
    const dispose = registerLayoutTransitionIntentHost("workspace-1", {
      prepare: async () => old,
    });
    expect(publishLayoutTransitionIntent({
      ownerKey: "workspace-1",
      revision: 1,
      from: arrangement(0, "left"),
      to: arrangement(50, "right"),
    })).toBe(true);
    dispose();
    registerLayoutTransitionIntentHost("workspace-1", {
      prepare: async () => fresh,
    });
    expect(publishLayoutTransitionIntent({
      ownerKey: "workspace-1",
      revision: 2,
      from: arrangement(50, "right"),
      to: arrangement(0, "left"),
    })).toBe(true);

    expect(claimLayoutTransitionIntent("workspace-1", 1)).toBeNull();
    await expect(claimLayoutTransitionIntent("workspace-1", 2)).resolves.toBe(fresh);
    await Promise.resolve();
    expect(old.cancel).toHaveBeenCalledTimes(1);
  });

  it("the next revision adapter prepare does not start before the claimed active terminal ACK", async () => {
    let resolveFirst!: (value: PreparedLayoutTransition) => void;
    const first = prepared("layout-1");
    const second = prepared("layout-2");
    const prepare = vi.fn()
      .mockImplementationOnce(() => new Promise<PreparedLayoutTransition>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(second);
    registerLayoutTransitionIntentHost("workspace-1", { prepare });

    publishLayoutTransitionIntent({
      ownerKey: "workspace-1",
      revision: 1,
      from: arrangement(0, "left"),
      to: arrangement(50, "right"),
    });
    const claimedFirst = claimLayoutTransitionIntent("workspace-1", 1);
    resolveFirst(first);
    await expect(claimedFirst).resolves.toBe(first);
    publishLayoutTransitionIntent({
      ownerKey: "workspace-1",
      revision: 2,
      from: arrangement(50, "right"),
      to: arrangement(0, "left"),
    });
    const claimedSecond = claimLayoutTransitionIntent("workspace-1", 2);

    expect(prepare).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(1);

    expect((finishLayoutTransitionIntent as unknown as (
      ownerKey: string,
      revision: number,
      terminal: { reason: string },
    ) => boolean)("workspace-1", 1, { reason: "visual-landing" })).toBe(true);
    expect(layoutTransitionIntentFacts().events.find((event) => (
      event.revision === 1 && event.phase === "finished"
    ))).toMatchObject({
      ownerKey: "workspace-1",
      revision: 1,
      phase: "finished",
      reason: "visual-landing",
    });
    await expect(claimedSecond).resolves.toBe(second);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("an active prepare replaced before the claim starts only the latest revision, after the AbortSignal terminal", async () => {
    let firstSignal: AbortSignal | undefined;
    const second = prepared("layout-2");
    const prepare = vi.fn((intent: { revision: number }, signal?: AbortSignal) => {
      if (intent.revision === 2) return Promise.resolve(second);
      firstSignal = signal;
      return new Promise<PreparedLayoutTransition>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    registerLayoutTransitionIntentHost("workspace-abort", { prepare });

    publishLayoutTransitionIntent({
      ownerKey: "workspace-abort",
      revision: 1,
      from: arrangement(0, "left"),
      to: arrangement(50, "right"),
    });
    publishLayoutTransitionIntent({
      ownerKey: "workspace-abort",
      revision: 2,
      from: arrangement(50, "right"),
      to: arrangement(0, "left"),
    });
    const latest = claimLayoutTransitionIntent("workspace-abort", 2);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstSignal?.aborted).toBe(true);
    await expect(latest).resolves.toBe(second);
    expect(prepare.mock.calls.map(([intent]) => intent.revision)).toEqual([1, 2]);
  });

  it("an active prepare that has not completed is closed by the replacement signal and the latest revision starts, even after React claimed it", async () => {
    let firstSignal: AbortSignal | undefined;
    const second = prepared("layout-2");
    const prepare = vi.fn((intent: { revision: number }, signal?: AbortSignal) => {
      if (intent.revision === 2) return Promise.resolve(second);
      firstSignal = signal;
      return new Promise<PreparedLayoutTransition>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    registerLayoutTransitionIntentHost("workspace-claimed-abort", { prepare });
    publishLayoutTransitionIntent({
      ownerKey: "workspace-claimed-abort",
      revision: 1,
      from: arrangement(0, "left"),
      to: arrangement(50, "right"),
    });
    const stale = claimLayoutTransitionIntent("workspace-claimed-abort", 1);
    void stale?.catch(() => {});
    publishLayoutTransitionIntent({
      ownerKey: "workspace-claimed-abort",
      revision: 2,
      from: arrangement(50, "right"),
      to: arrangement(0, "left"),
    });
    const latest = claimLayoutTransitionIntent("workspace-claimed-abort", 2);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstSignal?.aborted).toBe(true);
    await expect(latest).resolves.toBe(second);
    expect(prepare.mock.calls.map(([intent]) => intent.revision)).toEqual([1, 2]);
    expect(layoutTransitionIntentFacts()).toMatchObject({
      maxEvents: 64,
      owners: [{
        ownerKey: "workspace-claimed-abort",
        active: { revision: 2, started: true, prepared: true, claimed: true },
        queued: null,
      }],
      events: expect.arrayContaining([
        expect.objectContaining({ ownerKey: "workspace-claimed-abort", revision: 1, phase: "abort-requested" }),
        expect.objectContaining({ ownerKey: "workspace-claimed-abort", revision: 1, phase: "finished" }),
        expect.objectContaining({ ownerKey: "workspace-claimed-abort", revision: 2, phase: "promoted" }),
      ]),
    });
  });
});
