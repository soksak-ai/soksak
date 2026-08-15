import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "catalogDom.ts"), "utf8");

// When the document is wider than the window, the excess is clipped on the right. Any line drawn
// there is invisible, and the screen looks exactly like "no line was drawn" — same symptom, different
// cause.
//
// Measured 2026-08-15: window 999, document 1000. The pane's right edge was positioned 1px outside
// the viewport, and combined with flat drawing no frame it appeared as "the right outline is
// missing". Those are two different defects.
//
// An earlier round hit the same class and recorded it in this file — nobody caught it until a person
// looked at a screenshot. Geometry is judged by geometry.
describe("ui.verify checks that the document fits the window", () => {
  it("has a viewport-fits-window check", () => {
    expect(source).toContain('name: "viewport-fits-window"');
  });

  it("asks the framework for the window size", () => {
    // A document measured against its own size always passes. The reference size comes from the
    // framework, which holds the window size.
    const check = source.slice(source.indexOf('name: "viewport-fits-window"') - 1400);
    expect(check).toContain("window_monitors");
  });
});
