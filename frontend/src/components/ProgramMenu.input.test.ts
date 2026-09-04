import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/ProgramMenu.tsx", "utf8");

describe("ProgramMenu outside input contract", () => {
  it("closes for both native pointerdown and public mousedown input", () => {
    expect(source).toContain('window.addEventListener("pointerdown", onOutsidePointer, true)');
    expect(source).toContain('window.addEventListener("mousedown", onOutsidePointer, true)');
  });

  it("occludes the native surfaces it opens over", () => {
    // The menu opens at a point inside the layout, which is where the native pane surfaces are, and
    // a document overlay cannot be raised over one by any z-index. Registering without occlusion
    // draws the menu under the terminal — reported 2026-09-04.
    //
    // The second argument is the occlusion axis and its default is true. Passing false is what this
    // refuses; the call is read rather than the whole line, so a later edit to the first argument
    // does not fail here.
    const call = source.match(/useOverlayActive\(([^)]*)\)/);
    expect(call).not.toBeNull();
    expect(call![1]).not.toContain("false");
  });
});
