import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  layoutDecorationPresentation,
  type LayoutDecorationMotionReceipt,
} from "../lib/layoutDecorationPresentation";
import { isViewSurfaceVisible } from "./GroupArea";

const movingReceipt: LayoutDecorationMotionReceipt = {
  status: "moving",
  owner: "layout-rect-motion",
  generation: 3,
  sequence: 11,
  activeAnimations: 2,
};

describe("layout decoration lifecycle", () => {
  it("structure, focus, and rail are removed while moving, and the relation outline is present at once under the destination identity", () => {
    expect(layoutDecorationPresentation(movingReceipt)).toEqual({
      structuralFrames: "absent",
      focusBoundary: "absent",
      relationOverlay: "present",
      railSurface: "absent",
    });
    expect(layoutDecorationPresentation({
      status: "settled",
      owner: "layout-rect-motion",
      generation: 3,
      sequence: 12,
      activeAnimations: 0,
    })).toEqual({
      structuralFrames: "present",
      focusBoundary: "present",
      relationOverlay: "present",
      railSurface: "present",
    });
  });

  it("GroupArea and the rail read the same public lifecycle receipt", () => {
    const group = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    const app = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");
    expect(group).toContain("useLayoutDecorationPresentation(`${projectId}/${content.id}`)");
    expect(group).toContain("decoration.structuralFrames === \"present\"");
    expect(group).toContain("decoration.focusBoundary === \"present\"");
    expect(app).toContain("decoration.railSurface !== \"present\"");
    expect(group).toContain("!replaceGeometry && decoration.structuralFrames");
    expect(group).toContain("!replaceGeometry && decoration.focusBoundary");
    expect(app).toContain("decoration.relationOverlay === \"present\" && !phase.replacing");
    expect(app).toContain("railStation={effectiveRailRelation.station}");
    expect(app).toContain("railTraveling || phase.replacing || decoration.railSurface !== \"present\"");
    expect(app).toContain("<div\n              ref={railPlaneRef}");
    expect(app).toContain("? null\n                : <div");
    expect(app).not.toContain("railPlane={\n            railTraveling");
    expect(app).not.toContain('data-rail-role={rail.visible && !phase.replacing');
    expect(app).toContain("replaceGeometry={isActiveContent && phase.replacing}");
  });
});

describe("content view effective visibility", () => {
  it("focus boundary count is 0 while travelling and 1 on the active pane after settling", () => {
    const source = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    expect(source).toContain('className="pane-focus-boundary"');
    expect(source).toContain('key={`focus-frame-${content.activePaneId}`}');
    expect(source).toContain('data-node={`layout/focus-boundary/${content.activePaneId}`}');
    expect(source).toMatch(/\{!traveling\s*&&\s*!replaceGeometry\s*&&\s*decoration\.focusBoundary === "present"\s*&&\s*displayCells/);
    expect(source).not.toMatch(/pane-focus-boundary[^\n]*flip-move/);
    expect(source).not.toMatch(/className=\{`pane-border\$\{[\s\S]{0,180}focus/);
  });

  it("every structural frame is removed while travelling and rebuilt from the settled rect", () => {
    const source = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    expect(source).toMatch(/\{!traveling\s*&&\s*!replaceGeometry\s*&&\s*decoration\.structuralFrames === "present"\s*&&\s*displayCells\.map/);
    expect(source).not.toMatch(/displayCells\s*\.filter\(\(\{ group \}\) => !traveling \|\| !flipMoves\(group\.id\)\)/);
    expect(source).toContain('className="pane-border"');
    expect(source).toContain('data-node={`layout/frame/${group.id}`}');
    expect(source).not.toMatch(/className=\{`pane-border\$\{[^\n]*flip-move/);
  });

  it("a moving pane drops its chrome, and the nativeSurface slot takes no DOM FLIP", () => {
    const group = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    const app = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");
    expect(app).toContain("nativeSurfaceViewIds={nativeSurfaceViewIds(c)}");
    expect(group).toContain("nativeSurfaceViewIds?: readonly string[]");
    expect(group).toContain("viewTravelPresentation({");
    expect(group).toContain('presentation.coreChrome !== "present"');
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

  it("a parked workspace or space surface hides its active tab as well", () => {
    expect(isViewSurfaceVisible(false, null, "v1", "v1")).toBe(false);
  });

  it("an active surface shows the pane active tab only", () => {
    expect(isViewSurfaceVisible(true, null, "v1", "v1")).toBe(true);
    expect(isViewSurfaceVisible(true, null, "v2", "v1")).toBe(false);
  });

  it("while maximized, that one view is the only visible one", () => {
    expect(isViewSurfaceVisible(true, "v2", "v2", "v1")).toBe(true);
    expect(isViewSurfaceVisible(true, "v2", "v1", "v1")).toBe(false);
  });
});
