import { describe, expect, it } from "vitest";
import { layoutGeometrySignature } from "./layoutGeometrySignature";

// What a rect is made of, and nothing else.
//
// The rect tracker flushes once per layout commit. Running it on every render cancelled every
// interpolation before it played — measured 2026-08-17, 64 journeys and not one finished. So the
// effect is given this signature, and two rules follow from that: a render that changes no geometry
// produces the same string, and every input a rect actually depends on changes it. The first keeps
// a motion alive; the second keeps one from being skipped.
const base = {
  traveling: false,
  railStation: 0,
  railWidthPx: 0,
  paneInset: 5,
  replaceGeometry: false,
  cells: [{ id: "pan-a1b2c3", rect: { left: 0, top: 0, width: 50, height: 100 } }],
  slotIds: ["tab-a1b2c3"],
};

describe("the geometry signature", () => {
  it("is the same for a render that changed nothing about the layout", () => {
    expect(layoutGeometrySignature({ ...base })).toBe(layoutGeometrySignature({ ...base }));
  });

  it.each([
    ["a cell moved", { cells: [{ id: "pan-a1b2c3", rect: { left: 10, top: 0, width: 50, height: 100 } }] }],
    ["a cell resized", { cells: [{ id: "pan-a1b2c3", rect: { left: 0, top: 0, width: 60, height: 100 } }] }],
    ["a cell was renamed", { cells: [{ id: "pan-zzzzzz", rect: { left: 0, top: 0, width: 50, height: 100 } }] }],
    [
      "a cell arrived",
      {
        cells: [
          { id: "pan-a1b2c3", rect: { left: 0, top: 0, width: 50, height: 100 } },
          { id: "pan-d4e5f6", rect: { left: 50, top: 0, width: 50, height: 100 } },
        ],
      },
    ],
    ["the rail widened", { railWidthPx: 240 }],
    ["the rail moved to another station", { railStation: 50 }],
    ["the theme changed the inset", { paneInset: 6 }],
    ["the travel started", { traveling: true }],
    ["the layout was replaced rather than moved", { replaceGeometry: true }],
    ["a slot was rendered for the first time", { slotIds: ["tab-a1b2c3", "tab-d4e5f6"] }],
  ])("changes when %s", (_what, patch) => {
    expect(layoutGeometrySignature({ ...base, ...patch })).not.toBe(layoutGeometrySignature(base));
  });
});
