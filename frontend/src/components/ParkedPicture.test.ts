import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ParkedPicture stacking contract", () => {
  // The picture stands in for a native surface, which was composited above the focus lighting veil:
  // the veil is outside the document's reach for it. Drawn under that veil, a parked pane read 127
  // on white where the live one read 191 (measured 2026-09-04).
  //
  // The body it is drawn in declares no paint containment, or nothing inside could reach that layer.
  // The gate reads the relation, not a number.
  it("paints above the focus lighting veil, in a body that lets it", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../App.css"), "utf8");
    const rule = css.match(/\.parked-picture\s*\{([^}]*)\}/)?.[1] ?? "";
    const plane = css.match(/\.focus-lighting-plane\s*\{([^}]*)\}/)?.[1] ?? "";
    const body = css.match(/\.tab-body\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toContain("position: absolute");
    expect(rule).toContain("pointer-events: none");
    expect(body).not.toMatch(/contain\s*:[^;]*paint/);

    const layerOf = (block: string) => Number(block.match(/z-index:\s*(\d+)/)?.[1] ?? NaN);
    expect(layerOf(plane)).not.toBeNaN();
    expect(layerOf(rule)).toBeGreaterThan(layerOf(plane));
  });
});
