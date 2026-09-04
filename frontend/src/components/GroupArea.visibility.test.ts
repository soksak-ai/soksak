import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { layoutDecorationMotionReceipt } from "../lib/layoutDecorationPresentation";
import { isViewContentVisible } from "./GroupArea";


describe("what a motion takes off the screen", () => {
  // Nothing. A frame, a boundary, an outline and a rail all stay and travel with what they draw.
  //
  // They used to be removed for the duration of a motion, on the reasoning that they decorate a
  // settled arrangement. Measured 2026-08-17 across all six ways focus can move in a three-pane
  // window: every pane stood on the screen without its line for 148 to 372ms, and 165 points of the
  // window belonged to nobody for 147 to 194ms. A line that goes out and comes back is not a settled
  // arrangement either.
  it("renders decoration inside the library card", () => {
    const group = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    const app = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");
    // The frame is drawn and registered with the tracker that interpolates the cells, so it is one
    // frame that moves rather than two that appear and vanish.
    expect(group).toContain('node={`layout/frame/${group.id}`}');
    expect(group).toContain('node={`layout/focus-boundary/${group.id}`}');
    expect(group).toContain("<SplitPaneCardHost");
    expect(group).not.toContain("decoration.structuralFrames");
    expect(group).not.toContain("decoration.focusBoundary");
    expect(app).not.toContain("decoration.railSurface");
    expect(app).not.toContain("decoration.relationOverlay");
    // The lease survives: it is the record that a motion is running.
    expect(readFileSync(resolve(import.meta.dirname, "../lib/layoutRectMotion.ts"), "utf8"))
      .toContain("beginLayoutDecorationMotion");
  });

  it("still publishes the motion lease per scope", () => {
    expect(layoutDecorationMotionReceipt("nothing-has-moved")).toEqual({
      status: "settled",
      owner: "layout-rect-motion",
      generation: 0,
      sequence: 0,
      activeAnimations: 0,
    });
  });
});

describe("content view effective visibility", () => {
  it("the focus boundary is rendered inside the active library card", () => {
    const source = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    expect(source).toContain('className="pane-focus-boundary"');
    expect(source).toContain('node={`layout/focus-boundary/${group.id}`}');
    expect(source).toContain('active={surfaceActive && !traveling && group.id === content.activePaneId}');
  });

  it("every structural frame is drawn through a motion, on the tracker that moves the cells", () => {
    const source = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    expect(source).toContain('className="pane-border"');
    expect(source).toContain('node={`layout/frame/${group.id}`}');
    // The condition that took them away for the length of a motion is gone. What is left is the
    // structural snap, where the previous rect is a structure to discard rather than a start point.
    expect(source).toContain("<NativePaneBorder");
    expect(source).toContain('style={{ inset: 0 }}');
    expect(source).not.toContain("decoration.structuralFrames");
    expect(source).not.toMatch(/displayCells\s*\.filter\(\(\{ group \}\) => !traveling \|\| !flipMoves\(group\.id\)\)/);
    expect(source).not.toMatch(/className=\{`pane-border\$\{[^\n]*flip-move/);
  });

  it("structural frames have a native stroke so their border can remain above a native surface", () => {
    const source = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    // A DOM z-index cannot overtake an AppKit child webview. The structural frame therefore needs
    // the same native decoration plane as the focus boundary; keeping only pane-border would hide
    // the border exactly where the native surface is opaque.
    expect(source).toContain("NativePaneBorder");
    expect(source).toContain('data-native-decoration={active ? "pane-border" : undefined}');
  });

  it("a moving pane keeps its chrome identity, and the nativeSurface slot takes no DOM FLIP", () => {
    const group = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    const app = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");
    expect(app).toContain("nativeSurfaceViewIds={nativeSurfaceViewIds(c)}");
    expect(group).toContain("nativeSurfaceViewIds?: readonly string[]");
    expect(group).toContain("viewTravelPresentation({");
    expect(group).not.toContain('presentation.coreChrome !== "present"');
    expect(group).toContain('presentation.domSurfaceMotion === "active"');
    expect(group).not.toMatch(/className=\{`pane\$\{flipMoves\(group\.id\) \? " flip-move"/);
  });

  it("the focus lighting aperture follows the same candidate during a native glide and does not split the surface vertically", () => {
    const source = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    const lighting = source.split("const lightingFocusId")[1]
      ?.split("// A decoration span")[0] ?? "";
    const rendered = source.split("<FocusLightingPlane")[1]
      ?.split("{/* ── Resizer")[0] ?? "";

    expect(lighting).not.toContain('nativeSurfaceMotion === "active"');
    expect(lighting).toContain("moving: flipMoves(c.group.id)");
    expect(rendered).not.toContain('nativeSurfaceMotion !== "active"');
    expect(rendered).toContain("moving: flipMoves(lightingFocusCell.group.id)");
  });

  it("passes the workspace logical pane identity to the content presentation host explicitly", () => {
    const source = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    expect(source).toContain("logicalPaneId={group.id}");
  });

  it("exposes the content and native-surface visibility decision on each tab body", () => {
    const source = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    expect(source).toContain('data-content-visible={String(visibility.contentVisible)}');
    expect(source).toContain('data-surface-visible={String(visibility.surfaceVisible)}');
    expect(source).toContain('data-visibility-reason={visibility.reason}');
  });

  it("a parked workspace or space surface hides its active tab as well", () => {
    expect(isViewContentVisible(false, null, "v1", "v1")).toBe(false);
  });

  it("an active surface shows the pane active tab only", () => {
    expect(isViewContentVisible(true, null, "v1", "v1")).toBe(true);
    expect(isViewContentVisible(true, null, "v2", "v1")).toBe(false);
  });

  it("while maximized, that one view is the only visible one", () => {
    expect(isViewContentVisible(true, "v2", "v2", "v1")).toBe(true);
    expect(isViewContentVisible(true, "v2", "v1", "v1")).toBe(false);
  });

  it("an overlay keeps the DOM view visible", () => {
    expect(isViewContentVisible(true, null, "v1", "v1")).toBe(true);
  });

  it("layout travel keeps the DOM view visible", () => {
    expect(isViewContentVisible(true, null, "v1", "v1")).toBe(true);
  });
});
