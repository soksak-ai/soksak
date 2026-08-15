import { describe, expect, it } from "vitest";

import { BORDER_RULES } from "./borderContract";

/** An edge touching the outer border of the window — not a boundary between surfaces.
 *
 * A border line divides two surfaces. Past the window edge there is nothing to divide, and the OS window
 * frame already takes that boundary. So no one draws that edge — the argument that delegation does not hold
 * applies to a **seam between surfaces** only.
 *
 * Measured 2026-08-15 (flat, window width 1000):
 *   rail/left     x=0    border L 1px   ← window edge, yet drawn
 *   layout/frame/ x=225 w=775 → 1000    border R 0px   ← same kind of edge, not drawn
 * Two surfaces in the same state treated the same place differently, and the validator passed both. The
 * contract approved two contradictory conclusions at once (the state §B8-3 forbids).
 */
describe("window edge contract", () => {
  it("no rule declares that it owns the outer edge", () => {
    // For a surface at an edge station (0 or 100), one side is outside the window. A rule that declares it
    // draws that outer edge is the contradiction in this contract. Inner stations are seams on both sides, so
    // they are out of scope here.
    const outerOf = (station: string) => (station === "0" ? "left" : "right");
    const outer = BORDER_RULES.filter((rule) => {
      const at = /data-station="(0|100)"\]$/.exec(rule.selector.trim());
      if (!at || rule.kind !== "edges") return false;
      const edge = (rule.edges as Record<string, string>)[outerOf(at[1])];
      return edge !== undefined && edge !== "none";
    });
    expect(
      outer.map((r) => r.id),
      "the window edge is not a boundary between surfaces — no rule owns drawing it",
    ).toEqual([]);
  });

  it("a seam between surfaces still has an owner", () => {
    // If dropping the edge also drops the seam, the boundary ends up with no owner.
    const railSeam = BORDER_RULES.find((r) => r.id === "rail-ground-flat-station-start");
    expect(railSeam, "the rail/body seam has no owner in flat").toBeDefined();
    expect((railSeam?.edges as Record<string, string>).right).toBe("bd");
  });
});
