// A sidebar at the window's left edge is on the left of the window.
//
// The two edges are drawn by one component, after the work surface, inside a `flex-direction: row`
// plane. In `overlay` mode each is absolutely positioned and the CSS `left: 0` / `right: 0` puts it
// where its name states. In `push` mode the overlay is released and the element joins the flow — and
// the flow order is the DOM order, which puts both of them after the body.
//
// Measured 2026-08-19 on a running window, 999 wide, left edge open at width 300: `sidebar/left`
// stood at x=699 and its content drew at x=1003, outside the window. `push` is this edge's default,
// so that is what a person meets first.
//
// The fix is `order`, not a second DOM position: one component draws both edges, and moving the
// left one in the tree would be two renders of the same thing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "App.css"), "utf8");

/** The declaration blocks a selector appears in, whether it stands alone or in a comma list. A
 *  reader that only matched `\n<selector> {` would answer "no rule" for a selector written beside
 *  another, which reads the same as a rule nobody wrote. */
function blocks(selector: string): string[] {
  const out: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css))) {
    const heads = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((one) => one.trim());
    if (heads.includes(selector)) out.push(m[2]);
  }
  return out;
}

/** The numeric `order` a selector declares, or null when it declares none. */
function order(selector: string): number | null {
  for (const decls of blocks(selector)) {
    const m = /(?:^|;)\s*order\s*:\s*(-?\d+)/.exec(decls);
    if (m) return Number(m[1]);
  }
  return null;
}

describe("an edge sidebar taking room from the body", () => {
  it("puts the left edge before the body in the flow", () => {
    // Everything else in the plane is at the default order 0, so a negative number is what puts
    // this one first without naming the others.
    expect(order(".sidebar-edge-left.push")).not.toBeNull();
    expect(order(".sidebar-edge-left.push")!).toBeLessThan(0);
  });

  it("leaves the right edge where the flow already puts it", () => {
    // It is drawn after the body and its place is after the body — an order declared here would be
    // a second statement of what the DOM already states, and the two would drift.
    expect(order(".sidebar-edge-right.push")).toBeNull();
  });

  it("orders the resizer with the edge it belongs to", () => {
    // The handle is a sibling in the same flow. Left behind, it is a 5px strip in the middle of the
    // window that resizes a sidebar nowhere near it.
    expect(order(".sidebar-edge-left-resizer")).not.toBeNull();
    expect(order(".sidebar-edge-left-resizer")!).toBeLessThan(0);
  });
});
