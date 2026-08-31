import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/ProgramMenu.tsx", "utf8");

describe("ProgramMenu outside input contract", () => {
  it("closes for both native pointerdown and public mousedown input", () => {
    expect(source).toContain('window.addEventListener("pointerdown", onOutsidePointer, true)');
    expect(source).toContain('window.addEventListener("mousedown", onOutsidePointer, true)');
  });
});
