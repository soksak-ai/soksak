import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("titlebar region toggles", () => {
  it("the left sidebar address, active state, and action name the same region", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");
    const start = source.indexOf('data-node="titlebar/region/left"');
    expect(start).toBeGreaterThan(0);
    const button = source.slice(Math.max(0, start - 180), start + 320);
    expect(button).toContain("activeWorkspace?.regionOpen.left");
    expect(button).toContain('toggleRegion(activeWorkspace.id, "left")');
    expect(button).not.toContain("regionOpen.rail");
  });
});
