// Single truth for effective view visibility — visible only when all three layers (workspace, space,
// tab) are true.
// Reason for RED: the workspace layer was missing, so a view of an inactive workspace was reported to
// the core as "visible" and that workspace's native browser webview stayed on screen after the
// switch (measured snapshot).
import { describe, expect, it, vi } from "vitest";
import {
  resolveViewVisibility,
  surfaceShown,
  viewSurfacePlacement,
  viewSurfacePlacementForPresentation,
  viewSurfaceStyle,
} from "./viewPark";

describe("effective view visibility — all three layers", () => {
  it("an inactive workspace is not visible even when the space and the tab are active", () => {
    expect(surfaceShown(false, true, true, false, false)).toBe(false);
  });

  it("an inactive space is not visible", () => {
    expect(surfaceShown(true, false, true, false, false)).toBe(false);
  });

  it("an inactive tab is not visible", () => {
    expect(surfaceShown(true, true, false, false, false)).toBe(false);
  });

  it("visible only when all three layers are active", () => {
    expect(surfaceShown(true, true, true, false, false)).toBe(true);
  });

  // A native surface is composited above the document, so no z-index puts it under a modal — the
  // plugin manager opened and two browser pages drew over its card, measured 2026-08-17.
  it("an overlay over the window hides it, whatever the other three say", () => {
    expect(surfaceShown(true, true, true, true, false)).toBe(false);
  });
});

describe("view visibility ownership", () => {
  it("keeps DOM content visible while an overlay occludes an out-of-document surface", () => {
    expect(resolveViewVisibility(true, true, true, true, false)).toEqual({
      contentVisible: true,
      surfaceVisible: false,
      occluded: true,
      moving: false,
      reason: "overlay",
    });
  });

  it("keeps DOM content and the live surface visible through layout motion", () => {
    expect(resolveViewVisibility(true, true, true, false, true)).toEqual({
      contentVisible: true,
      surfaceVisible: true,
      occluded: false,
      moving: true,
      reason: "layout-motion",
    });
  });

  it("hides both content and surface when the active tab chain is false", () => {
    expect(resolveViewVisibility(true, true, false, false, false)).toEqual({
      contentVisible: false,
      surfaceVisible: false,
      occluded: false,
      moving: false,
      reason: "inactive-chain",
    });
  });

  it("names the fully visible state", () => {
    expect(resolveViewVisibility(true, true, true, false, false).reason).toBe("visible");
  });
});

describe("viewSurfaceStyle — exclusive (maximize) composition contract", () => {
  // A picture that is held is not a picture that is on screen. The declaration hid the surface as
  // soon as one was held, so the native hide raced the document's first paint of it: the pane read
  // 129.7 on white for three frames between 224.7 and 224.7 (measured 2026-09-04).
  it("keeps the surface applied while the picture is held but not yet on screen", () => {
    const presentation = resolveViewVisibility(true, true, true, true, false);
    expect(viewSurfacePlacementForPresentation(presentation, false, "held").desiredVisible)
      .toBe(true);
    expect(viewSurfacePlacementForPresentation(presentation, false, "shown").desiredVisible)
      .toBe(false);
  });

  it("keeps an overlay-occluded native surface applied until the parking owner captures it", () => {
    const presentation = resolveViewVisibility(true, true, true, true, false);

    expect(presentation.surfaceVisible).toBe(false);
    expect(viewSurfacePlacementForPresentation(presentation, false, "none")).toEqual({
      desiredVisible: true,
      dim: 0,
      topology: "visible",
      declaredPaneFrame: null,
    });
    expect(viewSurfacePlacementForPresentation(presentation, false, "shown")).toEqual({
      desiredVisible: false,
      dim: 0,
      topology: "retained-hidden",
      declaredPaneFrame: null,
    });
  });

  it("a travelling layout keeps the live surface under compositor ownership", () => {
    expect(surfaceShown(true, true, true, false, true)).toBe(true);
    expect(surfaceShown(true, true, true, false, false)).toBe(true);
  });

  it("an exclusive hide declares the layout owner exact parking frame instead of a ResizeObserver", () => {
    expect(viewSurfacePlacement(false, true)).toEqual({
      desiredVisible: false,
      dim: 0,
      topology: "exclusive-hidden",
      declaredPaneFrame: { x: 0, y: 0, w: 0, h: 0 },
    });
    expect(viewSurfacePlacement(false, false)).toEqual({
      desiredVisible: false,
      dim: 0,
      topology: "retained-hidden",
      declaredPaneFrame: null,
    });

    // The dim travels with the same object: they are one fact about one moment, and a view that
    // read them from two channels could dim after it was hidden.
    expect(viewSurfacePlacement(true, false, 0.5).dim).toBe(0.5);
    expect(viewSurfacePlacement(true, true)).toEqual({
      desiredVisible: true,
      dim: 0,
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
    // A visible child declares no visibility and inherits the ancestor workspace/space visibility.
    // Writing `visible` directly re-reveals the child under a hidden ancestor per the CSS rule, so
    // the active tab surface of an inactive workspace covers the screen.
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
    // The order is the rule: a surface that is about to be parked is photographed first, because a
    // surface that is already hidden has nothing to photograph and the pane it left goes blank.
    const order: string[] = [];
    let pictureAnswer: Promise<string | null> = Promise.resolve("data:image/png;base64,AAAA");
    vi.doMock("./contentViews", () => ({
      hasContentViewHost: () => true,
      // The picture is held until the native layer reports the page back, so the stand-in window
      // has to answer that too.
      lastAppliedSurfaces: () => ({
        surfaces: [{ id: "browser-win-a-v-1", x: 0, y: 0, w: 0, h: 0, visible: true }],
        atUnixMs: 0,
        latencyMs: 0,
        appliedMs: 0,
        commits: 1,
      }),
      contentViewHost: () => ({
        visible: async (label: string, visible: boolean) => {
          order.push("hide");
          seen.push([label, visible]);
        },
        picture: async () => {
          order.push("picture");
          return pictureAnswer;
        },
      }),
    }));
    vi.doMock("../plugins/hooks", () => ({ emitPluginEvent: () => {} }));
    // The plugin declared the surface, so the label exists to be read. Parking a label the core
    // rebuilt instead would address a name the plugin never used — the host refuses it and the
    // parking silently does not happen.
    document.body.innerHTML = `
      <div data-node="layout/tab/v-1">
        <div data-native-surface="browser" data-native-surface-id="browser-win-a-v-1"></div>
      </div>`;
    const { commitViewPresentation, dropViewVisibility } = await import("./viewPark");
    const { parkedPicture } = await import("./parkedPicture");

    dropViewVisibility("v-1");
    commitViewPresentation("v-1", resolveViewVisibility(true, true, true, true, false));
    // The picture is taken before the surface goes, so the commit lands after that answer rather
    // than in the same breath as the call.
    await new Promise((done) => setTimeout(done, 0));
    // The picture is in the store, but the document has not drawn it yet. Hiding the surface here
    // leaves one frame with the surface gone and nothing in its place — measured 2026-09-04: a pane
    // read 127 on white for one frame between 191 and 191.
    expect(order, "the surface is hidden before the picture is on screen").toEqual(["picture"]);
    const { markParkedPictureShown } = await import("./parkedPicture");
    markParkedPictureShown("v-1");
    await new Promise((done) => setTimeout(done, 0));
    expect(order).toEqual(["picture", "hide"]);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe("browser-win-a-v-1");
    expect(seen[0][1]).toBe(false);

    // Idempotent — recommitting the same value does nothing.
    commitViewPresentation("v-1", resolveViewVisibility(true, true, true, true, false));
    await Promise.resolve();
    expect(seen).toHaveLength(1);

    commitViewPresentation("v-1", resolveViewVisibility(true, true, true, false, false));
    await Promise.resolve();
    expect(seen[1][1]).toBe(true);

    // An inactive tab has a different owner on screen. Keeping the departing picture covers that
    // arriving view, so inactive-chain hides directly and retains no stand-in.
    dropViewVisibility("v-1");
    order.length = 0;
    seen.length = 0;
    commitViewPresentation("v-1", resolveViewVisibility(true, true, false, false, false));
    await Promise.resolve();
    expect(order).toEqual(["hide"]);
    expect(seen).toEqual([["browser-win-a-v-1", false]]);

    // A provider that cannot snapshot must not be hidden: there is no document picture to replace
    // it, and hiding it would produce the blank overlay reported by the running app.
    pictureAnswer = Promise.resolve(null);
    dropViewVisibility("v-1");
    order.length = 0;
    seen.length = 0;
    commitViewPresentation("v-1", resolveViewVisibility(true, true, true, true, false));
    await new Promise((done) => setTimeout(done, 0));
    expect(order).toEqual(["picture"]);
    expect(seen).toEqual([]);

    // A snapshot requested for motion may finish after the tab became inactive. Its result is stale
    // and cannot put the departing page back over the new active tab.
    let resolvePicture!: (value: string | null) => void;
    pictureAnswer = new Promise((resolve) => {
      resolvePicture = resolve;
    });
    dropViewVisibility("v-1");
    commitViewPresentation("v-1", resolveViewVisibility(true, true, true, true, false));
    commitViewPresentation("v-1", resolveViewVisibility(true, true, false, false, false));
    resolvePicture("data:image/png;base64,LATE");
    await new Promise((done) => setTimeout(done, 0));
    expect(parkedPicture("v-1")).toBeNull();
  });
});
