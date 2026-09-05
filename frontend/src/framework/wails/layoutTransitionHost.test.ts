import { describe, expect, it, vi } from "vitest";

const stage = vi.hoisted(() => vi.fn(async (visibleViewIds: ReadonlySet<string>) => ({
  sequence: 7,
  visibleViewIds: [...visibleViewIds].sort(),
})));
const restore = vi.hoisted(() => vi.fn(async () => {}));
const release = vi.hoisted(() => vi.fn());
vi.mock("./nativeSurfaces", () => ({
  restoreNativeSurfacePresentation: restore,
  stageNativeSurfacePresentation: stage,
  releaseNativeSurfacePresentation: release,
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
      preparation: {
        stages: [{ id: "native-presentation", status: "prepared", data: {
          sequence: 7,
          visibleViewIds: ["tab-left", "tab-right"],
        } }],
      },
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

  // The stage is a pre-announcement of the DOM the commit publishes; a commit ends it. Left in
  // force, a stage that hid a view the DOM then showed kept it hidden until another stage named
  // it: measured 2026-09-05 at boot, every terminal blank until the first click.
  it("releases the staged presentation when the transaction commits", async () => {
    release.mockClear();
    const prepared = await wailsLayoutTransitionHost.prepareChange({
      moves: [],
      projectionParticipants: [],
      panePresentationTargets: [{ viewId: "tab-a" }],
      paneSettlementParticipants: [],
    }, { transactionId: "layout-release" });
    expect(release).not.toHaveBeenCalled();
    await prepared.commit();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
