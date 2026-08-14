import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dimAmount, dimLevel, isDimmed } from "./dimLevel";
import { useSettings } from "../state/settings";
import { styleSurfaceRules } from "../ui/styleSurface";

/** The whole surface — the core stylesheet and each framework stylesheet stand in the document together.
 *  Reading one file drops a rule from the check the moment that rule moves to another file (ui/styleSurface). */
const rules = styleSurfaceRules();
const appTsx = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "App.tsx"),
  "utf8",
);

describe("dim level — many reasons, one value", () => {
  it("a focused pane is never dimmed", () => {
    expect(dimLevel({ active: true, focusDim: true, blocked: false })).toBe("clear");
    // Focus wins even when blocked is marked wrongly — what the user picked to look at is never covered.
    expect(dimLevel({ active: true, focusDim: true, blocked: true })).toBe("clear");
  });

  it("an idle pane dims only when the setting is on", () => {
    expect(dimLevel({ active: false, focusDim: true, blocked: false })).toBe("idle");
    expect(dimLevel({ active: false, focusDim: false, blocked: false })).toBe("clear");
  });

  it("a blocked pane is dim regardless of the dim setting — occlusion is a fact of the rail axis", () => {
    expect(dimLevel({ active: false, focusDim: false, blocked: true })).toBe("blocked");
    expect(dimLevel({ active: false, focusDim: true, blocked: true })).toBe("blocked");
  });

  it("isDimmed answers false for clear only", () => {
    expect(isDimmed("clear")).toBe(false);
    expect(isDimmed("idle")).toBe(true);
    expect(isDimmed("blocked")).toBe(true);
  });
});

describe("dim strength — the value comes from the setting", () => {
  it("the level takes the number the user set, unchanged", () => {
    const amounts = { idle: 0.5, blocked: 0.7 };
    expect(dimAmount("clear", amounts)).toBe(0);
    expect(dimAmount("idle", amounts)).toBe(0.5);
    expect(dimAmount("blocked", amounts)).toBe(0.7);
  });

  it("defaults are idle 50% and blocked 70%, set by the user on 2026-08-02", () => {
    const s = useSettings.getState();
    expect(s.dimIdle).toBeCloseTo(0.5, 3);
    expect(s.dimBlocked).toBeCloseTo(0.7, 3);
    // Blocked is deeper than idle — at equal values "covered" is not visible.
    expect(s.dimBlocked).toBeGreaterThan(s.dimIdle);
  });

  it("strength stays inside 0..1 — beyond it brightness inverts", () => {
    const s = useSettings.getState();
    s.setDimIdle(5);
    expect(useSettings.getState().dimIdle).toBe(1);
    s.setDimBlocked(-2);
    expect(useSettings.getState().dimBlocked).toBe(0);
    s.setDimIdle(0.5);
    s.setDimBlocked(0.7);
  });
});

describe("dim level — surface rules", () => {
  it("the level surfaces as one name and CSS paints one rule set per name, no per-reason selector", () => {
    // The old axis that painted per reason must not remain — if it does, specificity competes again.
    expect(rules).not.toMatch(/data-focus-dim/);
    expect(rules).not.toMatch(/\.rail-blocked/);
    expect(rules).not.toMatch(/\.spot-clear/);
  });

  it("both media read only the number from the surface — CSS never writes the strength", () => {
    // Only the shared lighting plane reads the alpha of the black veil, not a per-content filter. filter
    // rebuilds the compositing surface of a WebGL canvas and breaks the glyph atlas, so it is banned on the state surface.
    expect(rules).not.toMatch(/\.(?:pane|tab-body)\[data-dim\][^{]*\{[^}]*filter\s*:/s);
    expect(rules).toMatch(/\.focus-lighting-plane\b/);
    expect(rules).toMatch(/\.focus-lighting-region\b/);
    expect(rules).toMatch(/\.focus-lighting-mask\s*\{[^}]*mask-type:\s*luminance/s);
    for (const [sel, body] of [...rules.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
      (m) => [m[1] ?? "", m[2] ?? ""] as const,
    )) {
      if (!sel.includes("[data-dim")) continue;
      // No saturation term — the veil cannot lower saturation. Leaving one splits the hall pane and the DOM pane at the same level.
      expect(body, `${sel.trim()} has a saturation term`).not.toMatch(/saturate\(/);
      // No strength literal either — the one place for the value is the setting.
      expect(body, `${sel.trim()} writes the strength directly`).not.toMatch(/--dim:\s*[\d.]/);
    }
  });

});

describe("one box comes from one solution", () => {
  it("the blocked pane list comes from the solution the screen renders, the same place as the cells and the couplings", () => {
    // Measured 2026-08-02: reading from phase.displayed, moving focus in travel mode (nothing moves there by
    // definition) never updated the dim. The command had between=[pan-aecvk3,pan-q7lxti] while the slot stayed
    // idle and the geometry was identical.
    const m = appTsx.match(/betweenIds=\{[^}]*\}/);
    expect(m, "betweenIds wiring not found").toBeTruthy();
    // One box comes from one solution — blocked panes read the same solution as railCells and the couplings.
    // arrangementKey guarantees the phase takes a solution where only focus changed (a separate paired check covers it).
    expect(m?.[0]).toContain("arrangement?.betweenIds");
  });
});
