// **A surface must be inside the window.**
//
// Incident 2026-08-09: content surfaces scattered outside the window and stacked on the right of
// the screen. Nobody noticed until a human looked at a screenshot and called it broken —
// `ui.verify` still answered `passed` at that moment. That check read only the DOM, and what left
// the window was not DOM but an **out-of-document surface**.
//
// A visible surface outside the window is a defect, always. It is drawn where a human cannot see
// it, and no DOM check catches that. Geometry is judged by geometry.
import { describe, expect, it } from "vitest";
import { surfacesOutsideWindow, unknownSurfaces } from "./surfaceInsideWindow";

const surface = (label: string, x: number, y: number, w = 100, h = 100, hidden = false) =>
  ({ label, hidden, effectivelyHidden: hidden, frame: { x, y, w, h } });

const window = { w: 1000, h: 800 };

describe("a surface is inside the window", () => {
  it("a surface inside the window returns nothing", () => {
    expect(surfacesOutsideWindow([surface("a", 0, 0), surface("b", 900, 700)], window)).toEqual([]);
  });

  it("returns an outside surface by name and by how far it went out", () => {
    const out = surfacesOutsideWindow([surface("a", 1200, 100)], window);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("a");
    expect(out[0]!.overflow).toEqual({ right: 300, bottom: 0, left: 0, top: 0 });
  });

  it("a negative position is outside too", () => {
    expect(surfacesOutsideWindow([surface("a", -40, -10)], window)[0]!.overflow)
      .toEqual({ left: 40, top: 10, right: 0, bottom: 0 });
  });

  // A hidden surface is not visible to a human — whatever its position, it is not a fact about the screen.
  it("a hidden surface is not counted", () => {
    expect(surfacesOutsideWindow([surface("a", 5000, 5000, 100, 100, true)], window)).toEqual([]);
  });

  // Without the window size there is no verdict — with 0 every surface reads as outside.
  it("no verdict without a window size", () => {
    expect(surfacesOutsideWindow([surface("a", 1200, 100)], { w: 0, h: 0 })).toEqual([]);
  });

  // A one-pixel overhang is rounding error — the real incident showed hundreds of px.
  it("a 1px overhang is not counted as a defect", () => {
    expect(surfacesOutsideWindow([surface("a", 901, 0, 100, 100)], window)).toEqual([]);
  });
});

// **A surface the app does not track is on screen.**
//
// Measured 2026-08-09: a tab was closed but that tab's native surface stayed visible. The app's
// ghost check answered `ghosts: []` — that check scans **its own ledger**, and this surface was
// already dropped from the ledger and remained only in the native layer. A ghost gone from the
// ledger is not findable through the ledger.
//
// Such a surface then costs a check on every switch and covers part of the screen with no record
// of it. The check must compare the **list held by native** against the names the app tracks.
describe("a surface the app does not track", () => {
  it("returns by name a surface native holds and the app does not track", () => {
    expect(
      unknownSurfaces([surface("browser.win-main.tab-tab-gone", 0, 0), surface("browser.win-main.tab-tab-live", 0, 0)], new Set(["browser.win-main.tab-tab-live"])),
    ).toEqual(["browser.win-main.tab-tab-gone"]);
  });

  it("returns nothing for a surface the app tracks", () => {
    expect(unknownSurfaces([surface("browser.win-main.tab-tab-live", 0, 0)], new Set(["browser.win-main.tab-tab-live"]))).toEqual([]);
  });

  // A hidden surface is not a fact about the screen — not yet reclaimed differs from covering now.
  it("a hidden surface is not counted", () => {
    expect(unknownSurfaces([surface("browser.win-main.tab-tab-gone", 0, 0, 10, 10, true)], new Set())).toEqual([]);
  });
});
