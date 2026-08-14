import { describe, expect, it } from "vitest";
import {
  compareStackingPaths,
  declaredLayer,
  establishesStackingContext,
  stackingPathOf,
} from "./stackingOrder";

const style = (over: Record<string, string> = {}) => ({
  position: "static",
  zIndex: "auto",
  opacity: "1",
  transform: "none",
  filter: "none",
  backdropFilter: "none",
  perspective: "none",
  clipPath: "none",
  maskImage: "none",
  isolation: "auto",
  mixBlendMode: "normal",
  willChange: "auto",
  contain: "none",
  display: "block",
  ...over,
});

describe("the ancestor chain that fixes the paint order", () => {
  it("auto declares no layer — it is not 0", () => {
    expect(declaredLayer("7")).toBe(7);
    expect(declaredLayer("-1")).toBe(-1);
    expect(declaredLayer("auto")).toBeNull();
    expect(declaredLayer(undefined)).toBeNull();
  });

  it("a declaration that creates a stacking context is recognized", () => {
    expect(establishesStackingContext(style(), { isRoot: true })).toBe(true);
    expect(establishesStackingContext(style())).toBe(false);
    expect(establishesStackingContext(style({ position: "absolute", zIndex: "1" }))).toBe(true);
    // Positioning without a declared layer does not contain descendants.
    expect(establishesStackingContext(style({ position: "absolute" }))).toBe(false);
    expect(establishesStackingContext(style({ position: "fixed" }))).toBe(true);
    expect(establishesStackingContext(style({ opacity: "0.9" }))).toBe(true);
    expect(establishesStackingContext(style({ filter: "blur(2px)" }))).toBe(true);
    expect(establishesStackingContext(style({ transform: "translateX(1px)" }))).toBe(true);
    expect(establishesStackingContext(style({ isolation: "isolate" }))).toBe(true);
    expect(establishesStackingContext(style({ mixBlendMode: "multiply" }))).toBe(true);
    expect(establishesStackingContext(style({ willChange: "transform" }))).toBe(true);
    expect(establishesStackingContext(style({ contain: "paint" }))).toBe(true);
    // A flex/grid item creates a context when it declares z, even unpositioned.
    expect(establishesStackingContext(style({ zIndex: "2" }), { parentDisplay: "flex" })).toBe(true);
    expect(establishesStackingContext(style({ zIndex: "2" }), { parentDisplay: "block" })).toBe(false);
  });

  // Real incident: the rail plane (7) and the focus veil (6) are not in the same stacking context.
  // .space-plane (1) between them creates its own context and contains the veil — a check that just
  // subtracts the two z values misses that.
  it("only context-creating and positioned ancestors are included; ancestors irrelevant to order are dropped", () => {
    const document_ = new DOMParser().parseFromString(
      `<div id="root">
         <div id="plain"><div id="space"><div id="veil"></div></div></div>
       </div>`,
      "text/html",
    );
    const styles = new Map<string, Record<string, string>>([
      ["root", style({ position: "relative" })],
      ["plain", style()],
      ["space", style({ position: "absolute", zIndex: "1" })],
      ["veil", style({ position: "absolute", zIndex: "6" })],
    ]);
    const veil = document_.getElementById("veil")!;
    const path = stackingPathOf(veil, {
      getStyle: (node) => styles.get(node.id) ?? style(),
      identify: (node) => node.id,
    });

    // html and body are in-flow boxes and do not change the order. Only the root, contexts, positioned
    // boxes, and the node itself are included.
    expect(path.map((entry) => entry.identity)).toEqual(["", "root", "space", "veil"]);
    const last = path[path.length - 1];
    expect(last).toMatchObject({ identity: "veil", zIndex: 6, positioned: true });
    expect(path[2]).toMatchObject({ identity: "space", zIndex: 1 });
    // Child-index chain from the root — ties on the same layer are broken by document order.
    expect(last.order.length).toBeGreaterThan(path[2].order.length);
  });

  it("a positioned box with no declared layer is in the chain too", () => {
    const document_ = new DOMParser().parseFromString(
      `<div id="a"><div id="b"></div></div>`,
      "text/html",
    );
    const styles = new Map<string, Record<string, string>>([
      ["a", style({ position: "relative" })],
      ["b", style()],
    ]);
    const path = stackingPathOf(document_.getElementById("b")!, {
      getStyle: (node) => styles.get(node.id) ?? style(),
      identify: (node) => node.id,
    });
    expect(path.find((entry) => entry.identity === "a"))
      .toMatchObject({ zIndex: null, positioned: true });
  });

  it("the paint order is answered from the layer and document order at the first divergence after the common context", () => {
    const root = { identity: "root", node: null, zIndex: null, positioned: true, order: [0] };
    const sidebar = { identity: "sidebar", node: "sidebar", zIndex: 2, positioned: true, order: [0, 2] };
    const tabview = { identity: "tabview", node: "tabview", zIndex: 3, positioned: true, order: [0, 1] };
    expect(compareStackingPaths([root, tabview], [root, sidebar])).toBe(1);
    expect(compareStackingPaths([root, sidebar], [root, tabview])).toBe(-1);
    expect(compareStackingPaths([root, tabview], [root, tabview])).toBe(0);
    expect(compareStackingPaths([root], [root, tabview])).toBeNull();
  });
});
