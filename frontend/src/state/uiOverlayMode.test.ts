import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "./ui";

describe("overlay ownership", () => {
  beforeEach(() => {
    useUi.setState({ overlayCount: 0, nativeOverlayCount: 0, nativeOverlayAreas: [] });
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
  // What an overlay covers selects which surfaces and which card borders step aside. An overlay
  // that names no area covers the window — a modal is one. Measured 2026-09-04: a dropdown that
  // covered 31px of one pane took every pane's surface and every card border off the screen.
  it("records the area a native overlay covers, and drops it on the way out", () => {
    const area = { left: 10, top: 20, right: 110, bottom: 60 };
    useUi.getState().pushOverlay(true, area);
    expect(useUi.getState().nativeOverlayAreas).toEqual([area]);
    useUi.getState().popOverlay(true, area);
    expect(useUi.getState().nativeOverlayAreas).toEqual([]);
  });

  it("records an overlay that names no area as covering the window", () => {
    useUi.getState().pushOverlay(true);
    expect(useUi.getState().nativeOverlayAreas).toEqual([null]);
    useUi.getState().popOverlay(true);
    expect(useUi.getState().nativeOverlayAreas).toEqual([]);
  });

  it("keeps a menu overlay out of the native areas when it occludes nothing", () => {
    useUi.getState().pushOverlay(false, { left: 0, top: 0, right: 1, bottom: 1 });
    expect(useUi.getState().nativeOverlayAreas).toEqual([]);
  });
});
