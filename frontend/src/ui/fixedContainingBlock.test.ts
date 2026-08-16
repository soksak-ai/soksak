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
    // App.tsx wraps SectionSetHost in .sidebar-right, so everything that host
    // renders is inside the promoted box. A portal is the only thing that takes
    // an overlay back out to the window.
    const host = readFileSync(join(process.cwd(), "src", "components", "SectionSetHost.tsx"), "utf8");
    const modalsHere = [...host.matchAll(/<(\w*Modal)\b|className="dmodal-overlay"/g)].map(
      (m) => m[1] ?? "dmodal-overlay",
    );
    // Each of them is inside a createPortal call. Counting is enough: the host
    // has no other reason to portal, and a modal added without one moves the
    // counts apart.
    const portals = (host.match(/createPortal\(/g) ?? []).length;
    expect(portals).toBeGreaterThanOrEqual(modalsHere.length);
  });

  it("the plugin manager is mounted outside every promoted panel", () => {
    // The manager hung off the right sidebar's rail, inside the promoted box,
    // and reached the window only by portal. The rail is gone (A2a — the region
    // draws the standing set), so the manager is mounted by App itself.
    const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
    const sidebarRight = app.indexOf('className={`sidebar-right');
    const manager = app.indexOf("<PluginManagerModal");
    expect(manager).toBeGreaterThan(-1);
    // Oracle liveness — the promoted panel is still rendered here, so "outside"
    // is a placement rather than an absence.
    expect(sidebarRight).toBeGreaterThan(-1);

    // The manager's mount is not inside the sidebar-right element's JSX. That
    // element closes before the modal list begins.
    const sidebarBlockEnds = app.indexOf("</div>", app.indexOf("<SectionSetHost", sidebarRight));
    expect(manager).toBeGreaterThan(sidebarBlockEnds);
  });
});
