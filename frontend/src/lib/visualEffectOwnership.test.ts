// @vitest-environment node
// Visual effect ownership gate (static) — seals the class "an indirect event applies a visual effect
// to an unrelated surface".
// Incident: a descendant-wildcard selector under a phase class promoted even zero-delta slots onto a
// compositing layer with animation + will-change and back, so the browser DOM (address bar) twitched
// on every click of an unrelated tab.
// Principle (NATIVE-SURFACES §2): surface geometry and presentation change only by direct
// manipulation — a phase targets only the elements that actually change. This test enforces that
// principle at the CSS level.
import { describe, expect, it } from "vitest";
import { styleSurface } from "../ui/styleSurface";

// The whole surface — core and per-framework stylesheets are both in the document (ui/styleSurface).
const css = styleSurface();

/** Rule list: [selector, declarations] — comments are stripped before parsing. */
function rules(): [string, string][] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
    (m) => [m[1].replace(/\s+/g, " ").trim(), m[2]] as [string, string],
  );
}

// Properties that trigger compositing-layer promotion and re-raster — applied to an unrelated
// surface, it twitches on every phase.
const PROMOTING = ["animation", "will-change", "transform", "filter", "backdrop-filter"];
// Classes that mark phase and state (a wildcard under these means "unrelated elements included").
const PHASE = ["traveling", "dragging", "resizing", "data-dim"];

describe("visual effect ownership — no blanket selection under a phase class", () => {
  it("no filter is applied to a content surface — lighting is the separate plane responsibility", () => {
    const offenders = rules()
      .filter(([sel, body]) => /(?:\.pane|\.tab-body)(?:\b|\[)/.test(sel) && /(^|;)\s*filter\s*:/.test(body))
      .map(([sel]) => sel);
    expect(offenders).toEqual([]);
  });

  it("under a phase class, no layer-promoting property of a slot or cell is animated or transitioned", () => {
    // The check above already bans a persistent filter on content. This one is wider: it also blocks
    // animation/transition where a phase selector promotes a whole unrelated surface.
    const offenders: string[] = [];
    for (const [sel, body] of rules()) {
      if (!PHASE.some((p) => sel.includes(p))) continue;
      const decls = body
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean);
      const animates = decls.some((d) => {
        const [k, v = ""] = d.split(":").map((s) => s.trim());
        if (k === "animation" || k === "animation-name") return true;
        if (k === "will-change") return PROMOTING.some((p) => v.includes(p));
        if (k === "transition" || k === "transition-property")
          return PROMOTING.some((p) => v.includes(p)) || /\ball\b/.test(v);
        return false;
      });
      if (!animates) continue;
      const props = decls.map((d) => d.split(":")[0]?.trim()).filter(Boolean) as string[];
      // Each selector branch is checked separately — a branch that ends at a bare slot/cell with no
      // qualifier is a violation.
      for (const branch of sel.split(",").map((s) => s.trim())) {
        const last = branch.split(/\s+/).pop() ?? "";
        const bare =
          /^\.tab-body$/.test(last) || /^\.pane$/.test(last);
        if (bare) offenders.push(`${branch} → ${props.join(",")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Re-legislated (2026-07-26, user confirmed): a command-driven layout change must be real motion.
  // The old rule banned geometry transitions outright; narrow it to what the old rationale (a native
  // surface cannot follow a CSS transition) actually pointed at. A geometry transition is allowed,
  // but only with its pair present: (1) phase suppression (:root.layout-motion-live …
  // transition: none — drag and glide own the move in their own system). The Tauri-only exclusion is
  // owned by that adapter's test.
  it("a slot geometry transition exists only with its phase-suppression pair (re-legislated)", () => {
    let geometryTransition = false;
    for (const [sel, body] of rules()) {
      if (!/tab-body/.test(sel) || /layout-motion-live/.test(sel)) continue;
      const tr = /transition:\s*([^;]+)/.exec(body)?.[1] ?? "";
      // The geometry axis covers both property names and registered variables (--l/--t/--w/--h —
      // geometry interpolated through @property).
      if (/\b(left|top|width|height)\b|--[ltwh]\b/.test(tr)) geometryTransition = true;
      // transition: all stays banned outright — a transition that does not declare what moves has
      // no owner.
      expect(/\ball\b/.test(tr), `${sel} → transition:all is banned`).toBe(false);
    }
    if (geometryTransition) {
      const suppressed = rules().some(
        ([sel, body]) =>
          sel.includes("layout-motion-live") &&
          /tab-body/.test(sel) &&
          /transition:\s*none/.test(body),
      );
      expect(suppressed, "the phase-suppression pair (:root.layout-motion-live … transition:none) is missing").toBe(true);
    }
  });
});
