// Rail vertical borders — exhaustive comparison of contract and implementation.
//
// Two places state the same law independently: the contract table (rail-ground-*/rail-pane-* in
// borderContract) and the implementation (railEdges.railEdgeWidths). Fixing only one drifts silently, so the
// state space is compared exhaustively — railLook × open × station × paneStyle.
//
// RED evidence (measured 2026-07-27): the old rule asserted `.sidebar` right as 1px unconditionally and
// produced a permanent violation in a live window. A permanent violation becomes an alarm nobody reads, and
// then a real violation is buried. (That violation was real — the rail card, the delegate, did not own the line.)
//
// Selector semantics are not imitated: a real querySelectorAll runs against a real DOM. Reproducing the
// matching by hand would verify my reading instead of the contract.
import { beforeEach, describe, expect, it } from "vitest";
import { BORDER_RULES } from "./borderContract";
import { evaluateRules, type ElementProbe, type ValidateEnv } from "./borderValidate";
import { railEdgeWidths } from "./railEdges";

const BD = "rgb(58, 58, 58)";
const RAIL_RULES = BORDER_RULES.filter(
  (r) => r.id === "rail-perimeter",
);

type Look = "pane" | "ground";
type PaneStyle = "flat" | "card" | "floating";

const LOOKS: Look[] = ["pane", "ground"];
const STATIONS = [0, 0.5, 33.333333, 50, 99.5, 100];
const STYLES: PaneStyle[] = ["flat", "card", "floating"];

/** Probe that reads inline widths only — same axes as probeElement in the real validator (width/style/color). */
function probe(el: HTMLElement, open: boolean): ElementProbe {
  const edge = (w: number) =>
    w > 0
      ? { width: "1px", style: "solid", color: BD }
      : { width: "0px", style: "none", color: "rgba(0, 0, 0, 0)" };
  const l = Number(el.dataset.borderLeft);
  const r = Number(el.dataset.borderRight);
  return {
    edges: {
      top: edge(0),
      bottom: edge(0),
      left: edge(l),
      right: edge(r),
    },
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    // A closed rail has width 0 — no pixel to paint, so it is not judged (same rule as the validator).
    visible: open,
  };
}

function mount(look: Look, station: number, widths: { left: number; right: number }) {
  document.body.innerHTML = "";
  const el = document.createElement("div");
  el.className = `sidebar rail-${look}`;
  el.dataset.station = String(station);
  el.dataset.borderLeft = String(widths.left);
  el.dataset.borderRight = String(widths.right);
  document.body.appendChild(el);
  return el;
}

function env(open: boolean, paneStyle: PaneStyle): ValidateEnv {
  return {
    queryAll: (sel) =>
      [...document.querySelectorAll<HTMLElement>(sel)].map((el) => probe(el, open)),
    dataset: (name) => (name === "paneStyle" ? paneStyle : undefined),
    resolveToken: () => BD,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("rail vertical borders — contract ≡ implementation", () => {
  it("the rules exist (if they vanish from the contract table this suite guards nothing)", () => {
    expect(RAIL_RULES.map((r) => r.id)).toEqual(["rail-perimeter"]);
  });

  const cases: Array<[Look, number, PaneStyle]> = [];
  for (const look of LOOKS)
    for (const station of STATIONS) for (const style of STYLES) cases.push([look, station, style]);

  it.each(cases)(
    "open rail look=%s station=%s paneStyle=%s — the implemented widths satisfy the contract",
    (look, station, style) => {
      const widths = railEdgeWidths(look, true, station, style);
      mount(look, station, widths);
      const r = evaluateRules(RAIL_RULES, env(true, style));
      expect(r.violations).toEqual([]);
      // No gaps (§B8): in every state at least one rule must judge this element.
      expect(r.elementsChecked).toBeGreaterThan(0);
    },
  );

  it.each(cases)(
    "closed rail look=%s station=%s paneStyle=%s — zero width, so there is nothing to judge",
    (look, station, style) => {
      const widths = railEdgeWidths(look, false, station, style);
      expect(widths).toEqual({ left: 0, right: 0 });
      mount(look, station, widths);
      const r = evaluateRules(RAIL_RULES, env(false, style));
      expect(r.violations).toEqual([]);
      expect(r.elementsChecked).toBe(0);
    },
  );

  // Control group: whether this suite actually catches a violation (guards against fake GREEN).
  it.each([
    ["removing the rail perimeter at ground+card is a violation", "ground" as Look, 50, "card" as PaneStyle, { left: 0, right: 0 }],
    ["removing the outer rail perimeter at pane+station 0 is a violation", "pane" as Look, 0, "card" as PaneStyle, { left: 0, right: 0 }],
    ["removing the line at an inner pane station is a violation", "pane" as Look, 50, "card" as PaneStyle, { left: 0, right: 0 }],
  ])("%s", (_label, look, station, style, wrong) => {
    mount(look, station, wrong as { left: number; right: number });
    const r = evaluateRules(RAIL_RULES, env(true, style));
    expect(r.violations.length).toBeGreaterThan(0);
  });
});
