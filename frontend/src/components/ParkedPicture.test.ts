import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ParkedPicture stacking contract", () => {
  // The picture stands in for a native surface, which was composited above the focus lighting veil.
  // Drawn under that veil, a parked pane read 127 on white where the live one read 191; drawn under
  // it with a veil of its own, 96 (measured 2026-09-04).
  //
  // It takes the body's box as the body's sibling. Inside the body, its containment would keep the
  // picture off that layer whatever z-index it declared.
  it("paints above the focus lighting veil, and takes the body box beside the body", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../App.css"), "utf8");
    // The selector appears twice: once sharing the body box, once with what only the picture has.
    const blocks = [...css.matchAll(/\.parked-picture\s*\{([^}]*)\}/g)].map((one) => one[1]);
    const rule = blocks.find((block) => /z-index/.test(block)) ?? "";
    const plane = css.match(/\.focus-lighting-plane\s*\{([^}]*)\}/)?.[1] ?? "";
    const shared = css.match(/\.tab-body,\s*\.parked-picture\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toContain("pointer-events: none");
    expect(shared, "the body box is not shared with the picture").toContain("position: absolute");
    expect(shared).toContain("--header-h");

    const layerOf = (block: string) => Number(block.match(/z-index:\s*(\d+)/)?.[1] ?? NaN);
    expect(layerOf(plane)).not.toBeNaN();
    expect(layerOf(rule)).toBeGreaterThan(layerOf(plane));
  });
});
