import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const host = readFileSync(resolve(import.meta.dirname, "LeftSidebarHost.tsx"), "utf8");
const css = readFileSync(resolve(import.meta.dirname, "../App.css"), "utf8");

// The sidebar frame is a contract, and what goes inside it is the plugin's part. If the frame depends on the
// content, the frame itself disappears in a build with no plugins and that window gets a different skeleton
// from other windows — measured 2026-08-15: a workspace window with 0 plugins had no footer.
//
// This test reads source. It does not see rendering, so it can state only "it is written this way";
// "it looks this way" is answered by a capture.
describe("sidebar frame contract", () => {
  it("the footer slot does not depend on whether a plugin is present", () => {
    // The theme makes the slot and the plugin only puts text and icons inside it. An empty inside is
    // legitimate but a vanished slot is not — if a condition wraps the slot, only the window with no
    // plugins gets a different skeleton.
    const framedByCondition = /&&\s*\(?\s*<div className="sidebar-left-footer"/.test(host);
    expect(framedByCondition).toBe(false);

    const frameExists = /<div className="sidebar-left-footer"/.test(host);
    expect(frameExists).toBe(true);
  });

  it("a plugin does not set the slot height", () => {
    // If the height comes from the content, the band differs per plugin, and at that moment matching the
    // content footer becomes the plugin's choice.
    const rule = css.match(/\.sidebar-left-footer\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).not.toContain("flex: 0 0 auto");
  });

  it("the footer height uses the same band as the content footer", () => {
    const rule = css.match(/\.sidebar-left-footer\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("var(--status-h)");
  });

  it("the header band is present in the sidebar too", () => {
    const rule = css.match(/\.sidebar-left-header\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("var(--header-h)");
  });
});
