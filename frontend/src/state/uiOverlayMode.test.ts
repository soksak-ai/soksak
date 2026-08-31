import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "./ui";

describe("overlay ownership", () => {
  beforeEach(() => {
    useUi.setState({ overlayCount: 0, nativeOverlayCount: 0 });
  });

  it("keeps a menu overlay out of native occlusion while retaining input blocking", () => {
    useUi.getState().pushOverlay(false);
    expect(useUi.getState().overlayCount).toBe(1);
    expect(useUi.getState().nativeOverlayCount).toBe(0);
    useUi.getState().popOverlay(false);
    expect(useUi.getState().overlayCount).toBe(0);
    expect(useUi.getState().nativeOverlayCount).toBe(0);
  });

  it("counts a full overlay in both ownership channels", () => {
    useUi.getState().pushOverlay(true);
    expect(useUi.getState().nativeOverlayCount).toBe(1);
    useUi.getState().popOverlay(true);
    expect(useUi.getState().nativeOverlayCount).toBe(0);
  });
});
