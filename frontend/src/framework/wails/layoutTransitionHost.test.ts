import { describe, expect, it, vi } from "vitest";

const stage = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./nativeSurfaces", () => ({ stageNativeSurfacePresentation: stage }));

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
});
