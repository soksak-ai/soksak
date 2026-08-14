// Single truth for effective view visibility — visible only when all three layers (project, space,
// tab) are true.
// Reason for RED: the project layer was missing, so a view of an inactive project was reported to
// the core as "visible" and that project's native browser webview stayed on screen after the
// switch (measured snapshot).
import { describe, expect, it, vi } from "vitest";
import { surfaceShown, viewSurfacePlacement, viewSurfaceStyle } from "./viewPark";

describe("effective view visibility — all three layers", () => {
  it("an inactive project is not visible even when the space and the tab are active", () => {
    expect(surfaceShown(false, true, true)).toBe(false);
  });

  it("an inactive space is not visible", () => {
    expect(surfaceShown(true, false, true)).toBe(false);
  });

  it("an inactive tab is not visible", () => {
    expect(surfaceShown(true, true, false)).toBe(false);
  });

  it("visible only when all three layers are active", () => {
    expect(surfaceShown(true, true, true)).toBe(true);
  });
});

describe("viewSurfaceStyle — exclusive (maximize) composition contract", () => {
  it("an exclusive hide declares the layout owner exact parking frame instead of a ResizeObserver", () => {
    expect(viewSurfacePlacement(false, true)).toEqual({
      desiredVisible: false,
      topology: "exclusive-hidden",
      declaredPaneFrame: { x: 0, y: 0, w: 0, h: 0 },
    });
    expect(viewSurfacePlacement(false, false)).toEqual({
      desiredVisible: false,
      topology: "retained-hidden",
      declaredPaneFrame: null,
    });
    expect(viewSurfacePlacement(true, true)).toEqual({
      desiredVisible: true,
      topology: "visible",
      declaredPaneFrame: null,
    });
  });

  it("an ordinary deactivation keeps the DOM alive and turns off ordinary visibility only", () => {
    expect(viewSurfaceStyle(false, false).display).toBeUndefined();
    expect(viewSurfaceStyle(false, false)).toMatchObject({
      visibility: "hidden",
      pointerEvents: "none",
    });
    expect(viewSurfaceStyle(false, false)).not.toHaveProperty("transform");
    expect(viewSurfaceStyle(false, false)).not.toHaveProperty("zIndex");
  });

  it("a slot excluded from maximize is display:none so WebGL and GPU composition drop it too", () => {
    expect(viewSurfaceStyle(false, true)).toMatchObject({
      display: "none",
      visibility: "hidden",
    });
  });

  it("the maximize target uses the same display style as an ordinary active slot", () => {
    expect(viewSurfaceStyle(true, true).display).toBeUndefined();
    // A visible child declares no visibility and inherits the ancestor project/space visibility.
    // Writing `visible` directly re-reveals the child under a hidden ancestor per the CSS rule, so
    // the active tab surface of an inactive project covers the screen.
    expect(viewSurfaceStyle(true, true).visibility).toBeUndefined();
  });
});

describe("a parking commit goes through the content view host", () => {
  // Calling `invoke("webview_visible")` directly here is rejected as **delegated**
  // (FRAMEWORK_DELEGATED) on a framework whose content is inside the DOM. `.catch(()=>{})` then
  // swallows that rejection and parking never happens — switching tabs leaves the previous view up
  // and the new view invisible.
  //
  // Measured 2026-07-30: 301 such rejections had accumulated in the request ledger, and on screen
  // it showed as "clicking a tab does not restore the browser". contentViews is the single owner
  // of how the app presents content.
  it("with a DOM host, parking actually touches the DOM", async () => {
    vi.resetModules();
    const seen: [string, boolean][] = [];
    vi.doMock("./contentViews", () => ({
      contentViewHost: () => ({
        visible: async (label: string, visible: boolean) => {
          seen.push([label, visible]);
        },
      }),
    }));
    vi.doMock("../plugins/hooks", () => ({ emitPluginEvent: () => {} }));
    const { commitViewVisibility, dropViewVisibility } = await import("./viewPark");

    dropViewVisibility("v-1");
    commitViewVisibility("v-1", false);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toBe(false);

    // Idempotent — recommitting the same value does nothing.
    commitViewVisibility("v-1", false);
    await Promise.resolve();
    expect(seen).toHaveLength(1);

    commitViewVisibility("v-1", true);
    await Promise.resolve();
    expect(seen[1][1]).toBe(true);
  });
});
