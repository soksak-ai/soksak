import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutSettlementForTest,
  invalidateLayout,
  layoutSettlementEvents,
  layoutSettlementFacts,
  onLayoutSettlement,
  settleLayout,
} from "./layoutSettlement";

describe("layoutSettlement — the revision barrier between state mutation and the presentation solution", () => {
  it("keeps the pre-publish invalidation epoch as a public bounded event receipt", () => {
    invalidateLayout("t-acquisition");

    expect(layoutSettlementEvents("t-acquisition")).toEqual([
      {
        key: "t-acquisition",
        phase: "invalidated",
        revision: 1,
        clock: "unix-anchored-monotonic",
        atUnixMs: expect.any(Number),
      },
    ]);
  });

  afterEach(__resetLayoutSettlementForTest);

  it("closes only when the latest per-project invalidation is settled", () => {
    const listener = vi.fn();
    const off = onLayoutSettlement(listener);
    expect(invalidateLayout("t1")).toBe(1);
    expect(invalidateLayout("t1")).toBe(2);
    expect(invalidateLayout("t2")).toBe(1);
    expect(layoutSettlementFacts()).toMatchObject({ active: true });
    settleLayout("t1", 2);
    expect(layoutSettlementFacts().pending.map((item) => item.key)).toEqual(["t2"]);
    settleLayout("t2", 1);
    expect(layoutSettlementFacts()).toMatchObject({ active: false, pending: [] });
    expect(listener).toHaveBeenCalledTimes(5);
    expect(listener.mock.calls.map(([event]) => ({
      key: event.key, phase: event.phase, revision: event.revision,
    }))).toEqual([
      { key: "t1", phase: "invalidated", revision: 1 },
      { key: "t1", phase: "invalidated", revision: 2 },
      { key: "t2", phase: "invalidated", revision: 1 },
      { key: "t1", phase: "settled", revision: 2 },
      { key: "t2", phase: "settled", revision: 1 },
    ]);
    expect(listener.mock.calls.every(([event]) => (
      event.clock === "unix-anchored-monotonic" && Number.isFinite(event.atUnixMs)
    ))).toBe(true);
    off();
  });

  it("a transaction owner ACKs only the exact revision it opened and does not close a later revision on its behalf", () => {
    const listener = vi.fn();
    onLayoutSettlement(listener);
    const maximizeRevision = invalidateLayout("t1");
    const restoreRevision = invalidateLayout("t1");

    settleLayout("t1", maximizeRevision);
    expect(layoutSettlementFacts("t1")).toMatchObject({
      active: true,
      pending: [{ key: "t1", requested: restoreRevision, settled: maximizeRevision }],
    });
    settleLayout("t1", maximizeRevision);
    expect(listener).toHaveBeenCalledTimes(3);

    settleLayout("t1", restoreRevision);
    expect(layoutSettlementFacts("t1")).toMatchObject({ active: false, pending: [] });
    expect(listener.mock.calls.map(([event]) => ({
      key: event.key, phase: event.phase, revision: event.revision,
    }))).toEqual([
      { key: "t1", phase: "invalidated", revision: maximizeRevision },
      { key: "t1", phase: "invalidated", revision: restoreRevision },
      { key: "t1", phase: "settled", revision: maximizeRevision },
      { key: "t1", phase: "settled", revision: restoreRevision },
    ]);
  });
});
