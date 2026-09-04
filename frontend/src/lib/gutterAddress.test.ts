// A gutter is named by a pane and one of its edges, and the canonical name is the right|bottom
// edge of the first pane in reading order standing on that line (IDENTITY §4: a line's index is
// not a name — it shifts when a line is added before it).
import { describe, expect, it } from "vitest";
import { canonicalGutter, gutterAddress, gutterOwnerOf, resolveGutter } from "./gutterAddress";
import { splitPane, standRail } from "../state/panePlane";
import { columnPlane, planeOf, rowPlane } from "../test/planes";

const box = { width: 1000, height: 600, gap: 0 };

describe("① totality · ② uniqueness — every gutter has exactly one canonical address", () => {
  it("the canonical of a row is the left pane's right", () => {
    expect(gutterOwnerOf(rowPlane(["a", "b"]), "x", 1)).toEqual({ pane: "a", side: "right" });
    expect(gutterAddress("a", "right")).toBe("gutter/a/right");
  });

  it("the canonical of a column is the upper pane's bottom", () => {
    expect(gutterOwnerOf(columnPlane(["a", "b"]), "y", 1)).toEqual({ pane: "a", side: "bottom" });
  });

  // a | b on top, c | d below on the same line: a and c both end on it, and a is first in reading
  // order, so the address is a's alone.
  it("a line two rows meet on is named by the first pane in reading order", () => {
    const top = splitPane(rowPlane(["a", "b"]), box, "a", "bottom", "c")!;
    const both = splitPane(top, box, "b", "bottom", "d")!;
    expect(gutterOwnerOf(both, "x", 1)).toEqual({ pane: "a", side: "right" });
    expect(canonicalGutter(both, "c", "right")).toEqual({ pane: "a", side: "right" });
    expect(canonicalGutter(both, "d", "left")).toEqual({ pane: "a", side: "right" });
  });

  it("a border of the plane is no gutter — nothing absent gets an address", () => {
    const plane = rowPlane(["a", "b"]);
    expect(gutterOwnerOf(plane, "x", 0)).toBeNull();
    expect(gutterOwnerOf(plane, "x", 2)).toBeNull();
    expect(gutterOwnerOf(plane, "y", 0)).toBeNull();
  });

  it("the rail's edges are no pane's gutter, and the line beside it is named by the pane", () => {
    const plane = standRail(rowPlane(["a", "b"]), box, 1, 100)!;
    // a | rail | b: a ends on line 1, the rail on line 2.
    expect(gutterOwnerOf(plane, "x", 1)).toEqual({ pane: "a", side: "right" });
    expect(gutterOwnerOf(plane, "x", 2)).toBeNull();
  });
});

describe("③ round trip — a canonical address mapped back to the line is the gutter it started from", () => {
  it("every gutter of a plane round-trips", () => {
    const plane = planeOf("a", { id: "b", side: "right", of: "a" }, { id: "c", side: "bottom", of: "b" });
    for (const axis of ["x", "y"] as const) {
      const last = (axis === "x" ? plane.xs : plane.ys).length - 1;
      for (let line = 1; line < last; line++) {
        const owner = gutterOwnerOf(plane, axis, line);
        expect(owner, `${axis}:${line}`).not.toBeNull();
        expect(resolveGutter(plane, owner!.pane, owner!.side)).toEqual({ axis, line });
      }
    }
  });

  it("an outer edge of the layout does not resolve — the last pane's right has no gutter", () => {
    expect(resolveGutter(rowPlane(["a", "b"]), "b", "right")).toBeNull();
    expect(resolveGutter(rowPlane(["a", "b"]), "a", "left")).toBeNull();
  });

  it("a pane that is not on the plane is null — no guessing", () => {
    expect(resolveGutter(rowPlane(["a", "b"]), "zzz", "right")).toBeNull();
    expect(canonicalGutter(rowPlane(["a", "b"]), "zzz", "right")).toBeNull();
  });
});

describe("④ alias — left|top are the preceding edge and map back to the canonical form", () => {
  it("b.left and a.right are the same gutter", () => {
    const plane = rowPlane(["a", "b"]);
    expect(resolveGutter(plane, "b", "left")).toEqual(resolveGutter(plane, "a", "right"));
    expect(canonicalGutter(plane, "b", "left")).toEqual({ pane: "a", side: "right" });
  });

  it("top follows the same rule — it maps back to the upper pane's bottom", () => {
    const plane = columnPlane(["a", "b"]);
    expect(canonicalGutter(plane, "b", "top")).toEqual({ pane: "a", side: "bottom" });
  });
});
