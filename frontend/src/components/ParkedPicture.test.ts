import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ParkedPicture stacking contract", () => {
  it("paints above the provider body that otherwise covers the captured pixels", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../App.css"), "utf8");
    const rule = css.match(/\.parked-picture\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toContain("position: absolute");
    expect(rule).toMatch(/z-index:\s*1/);
    expect(rule).toContain("pointer-events: none");
  });
});
