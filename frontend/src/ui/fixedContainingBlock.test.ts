// A modal is positioned against the window, not against whatever panel opened it.
//
// `position: fixed` resolves against the viewport — unless an ancestor has
// `transform`, `will-change: transform`, `filter`, `perspective` or `contain`.
// Then that ancestor becomes the containing block and the modal is laid out
// inside it.
//
// Measured 2026-08-15: the plugin manager's close button sat at x=962.78 on a
// 1200-wide window. .sidebar-right declares `will-change: transform` so the
// compositor keeps host chrome above a plugin's WebGL canvas, and the modal was
// rendered inside that subtree, so `left: 50%` was half of the sidebar.
//
// The fix is where the modal is mounted, not what the sidebar declares: the
// compositing promotion is load-bearing and removing it puts plugin content
// over the chrome again.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src", "App.css"), "utf8");

/** The declaration block of one selector, or null. */
function block(selector: string): string | null {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

/** Properties that make an element the containing block of a fixed descendant. */
const CONTAINING = /(^|[\s;])(transform|perspective|filter|backdrop-filter|contain)\s*:|will-change\s*:[^;]*\b(transform|filter|perspective)\b/;

describe("a fixed overlay is positioned against the window", () => {
  it("names the panels that are a containing block for fixed children", () => {
    // Not a violation on its own — this pins which ones they are, so a modal
    // mounted inside one is a decision rather than an accident.
    const promoted = [".sidebar-right"].filter((s) => CONTAINING.test(block(s) ?? ""));
    expect(promoted).toEqual([".sidebar-right"]);
  });

  it("the modal overlay is fixed and full-window", () => {
    const overlay = block(".dmodal-overlay") ?? "";
    expect(overlay).toMatch(/position:\s*fixed/);
    expect(overlay).toMatch(/inset:\s*0/);
  });

  it("a modal rendered under a promoted panel goes through a portal", () => {
    // App.tsx wraps PluginSidebar in .sidebar-right, so everything that
    // component renders is inside the promoted box — including a modal it
    // renders itself and one it renders through a child. A portal is the only
    // thing that takes the overlay back out to the window.
    const sidebar = readFileSync(join(process.cwd(), "src", "components", "PluginSidebar.tsx"), "utf8");
    const modalsHere = [...sidebar.matchAll(/<(\w*Modal)\b|className="dmodal-overlay"/g)].map(
      (m) => m[1] ?? "dmodal-overlay",
    );
    expect(modalsHere.length).toBeGreaterThan(0);

    // Each of them is inside a createPortal call. Counting is enough: the
    // component has no other reason to portal, and a modal added without one
    // moves the counts apart.
    const portals = (sidebar.match(/createPortal\(/g) ?? []).length;
    expect(portals).toBe(modalsHere.length);
  });
});
