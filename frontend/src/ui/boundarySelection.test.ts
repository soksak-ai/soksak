import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../App.css"), "utf8");

describe("boundary drag selection contract", () => {
  it("the shared resize phase disables selection across the document", () => {
    const rule = css.match(/:root\[data-layout-resizing="true"\][^{]*\{[^}]*\}/s)?.[0] ?? "";
    expect(rule).toMatch(/-webkit-user-select:\s*none/);
    expect(rule).toMatch(/user-select:\s*none/);
  });
});
