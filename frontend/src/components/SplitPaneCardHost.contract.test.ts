import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const hostSource = readFileSync(join(process.cwd(), "src", "components", "SplitPaneCardHost.tsx"), "utf8");
const cssSource = readFileSync(join(process.cwd(), "src", "App.css"), "utf8");

describe("SplitPaneCardHost uses the split-pane visual contract", () => {
  it("uses the library class namespace and keeps generated boundary rules", () => {
    expect(hostSource).toContain('classPrefix: "sp"');
    expect(hostSource).not.toContain('classPrefix: "pane"');
    expect(hostSource).not.toContain("rules: false");
  });

  it("styles the library divider grab area for both axes", () => {
    expect(cssSource).toContain('.sp-divider[data-axis="x"]');
    expect(cssSource).toContain('.sp-divider[data-axis="y"]');
    expect(cssSource).toContain(".sp-rule");
  });
});
