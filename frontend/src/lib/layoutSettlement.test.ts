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

  it("closes only when the latest per-workspace invalidation is settled", () => {
    const listener = vi.fn();
    const off = onLayoutSettlement(listener);
    expect(invalidateLayout("wsp-4h7kq2")).toBe(1);
    expect(invalidateLayout("wsp-4h7kq2")).toBe(2);
    expect(invalidateLayout("wsp-9m3xb5")).toBe(1);
    expect(layoutSettlementFacts()).toMatchObject({ active: true });
    settleLayout("wsp-4h7kq2", 2);
    expect(layoutSettlementFacts().pending.map((item) => item.key)).toEqual(["wsp-9m3xb5"]);
    settleLayout("wsp-9m3xb5", 1);
    expect(layoutSettlementFacts()).toMatchObject({ active: false, pending: [] });
    expect(listener).toHaveBeenCalledTimes(5);
    expect(listener.mock.calls.map(([event]) => ({
      key: event.key, phase: event.phase, revision: event.revision,
    }))).toEqual([
      { key: "wsp-4h7kq2", phase: "invalidated", revision: 1 },
      { key: "wsp-4h7kq2", phase: "invalidated", revision: 2 },
      { key: "wsp-9m3xb5", phase: "invalidated", revision: 1 },
      { key: "wsp-4h7kq2", phase: "settled", revision: 2 },
      { key: "wsp-9m3xb5", phase: "settled", revision: 1 },
    ]);
    expect(listener.mock.calls.every(([event]) => (
      event.clock === "unix-anchored-monotonic" && Number.isFinite(event.atUnixMs)
    ))).toBe(true);
    off();
  });

  it("a transaction owner ACKs only the exact revision it opened and does not close a later revision on its behalf", () => {
    const listener = vi.fn();
    onLayoutSettlement(listener);
    const maximizeRevision = invalidateLayout("wsp-4h7kq2");
    const restoreRevision = invalidateLayout("wsp-4h7kq2");

    settleLayout("wsp-4h7kq2", maximizeRevision);
    expect(layoutSettlementFacts("wsp-4h7kq2")).toMatchObject({
      active: true,
      pending: [{ key: "wsp-4h7kq2", requested: restoreRevision, settled: maximizeRevision }],
    });
    settleLayout("wsp-4h7kq2", maximizeRevision);
    expect(listener).toHaveBeenCalledTimes(3);

    settleLayout("wsp-4h7kq2", restoreRevision);
    expect(layoutSettlementFacts("wsp-4h7kq2")).toMatchObject({ active: false, pending: [] });
    expect(listener.mock.calls.map(([event]) => ({
      key: event.key, phase: event.phase, revision: event.revision,
    }))).toEqual([
      { key: "wsp-4h7kq2", phase: "invalidated", revision: maximizeRevision },
      { key: "wsp-4h7kq2", phase: "invalidated", revision: restoreRevision },
      { key: "wsp-4h7kq2", phase: "settled", revision: maximizeRevision },
      { key: "wsp-4h7kq2", phase: "settled", revision: restoreRevision },
    ]);
  });
});
