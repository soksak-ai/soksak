import { describe, expect, it, vi } from "vitest";

const stage = vi.hoisted(() => vi.fn(async () => {}));
const restore = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./nativeSurfaces", () => ({
  restoreNativeSurfacePresentation: restore,
  stageNativeSurfacePresentation: stage,
}));

import { wailsLayoutTransitionHost } from "./layoutTransitionHost";

describe("Wails layout presentation staging", () => {
  it("stages every native view that remains visible in the target arrangement", async () => {
    const prepared = await wailsLayoutTransitionHost.prepareChange({
      moves: [],
      projectionParticipants: [],
      panePresentationTargets: [{ viewId: "tab-left" }],
      paneSettlementParticipants: [{ viewId: "tab-right" }],
    }, { transactionId: "layout-7" });

    expect(stage).toHaveBeenCalledWith(new Set(["tab-left", "tab-right"]));
    expect(prepared).toMatchObject({
      transactionId: "layout-7",
      mode: "glide",
      requiresSharedStart: false,
      stagedTargets: [],
    });
    await expect(prepared.start()).resolves.toBeNull();
    await expect(prepared.commit()).resolves.toBeUndefined();
  });

  it("restores the DOM presentation only when a staged transaction is cancelled", async () => {
    restore.mockClear();
    const change = {
      moves: [],
      projectionParticipants: [],
      panePresentationTargets: [{ viewId: "tab-a" }],
      paneSettlementParticipants: [],
    } as const;
    const cancelled = await wailsLayoutTransitionHost.prepareChange(change, {
      transactionId: "layout-cancel",
    });
    cancelled.cancel();
    await Promise.resolve();
    expect(restore).toHaveBeenCalledTimes(1);

    const committed = await wailsLayoutTransitionHost.prepareChange(change, {
      transactionId: "layout-commit",
    });
    await committed.commit();
    committed.cancel();
    await Promise.resolve();
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
