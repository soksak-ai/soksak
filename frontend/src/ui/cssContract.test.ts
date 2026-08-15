// UI alignment constitution (docs/UI.md) machine gate — parses App.css and fails on rule violations.
// R1 (band padding contract): items in a horizontal band carry no height (stretch fills them).
//   Only the strip's padding-block variables (--tab-pad/--ws-pad) own the spacing.
// R2: no position-correction hacks (negative offset, translateY, scale) on tab-like items.
// Do not weaken this test because something fails it — if the standard is wrong, correct the rule
// in docs/UI.md first (no-betrayal clause).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RAIL_TRAVEL_MS } from "../lib/railMotion";
import {
  focusVeilStackingViolations,
  projectRailStackingViolations,
} from "./focusVeilStacking";

const css = readFileSync(join(process.cwd(), "src", "App.css"), "utf8");

// Simple parser: split into top-level "selector { decls }" units (no nesting — App.css is flat).
// Strip comments attached to a selector so a comma inside a comment does not corrupt the split.
function rules(): Array<{ selector: string; decls: string }> {
  const out: Array<{ selector: string; decls: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    out.push({ selector, decls: m[2] });
  }
  return out;
}

// Tab-like box classes (band sibling box contract). The \w- boundary excludes .project-tabs/.project-tab-dot.
const BAND_ITEM = /\.(tab|tab-add|space-tab-add|project-tab-add|space-tab|project-tab)(?![\w-])/;

// Outside the contract: vertical rail (square chips) and vertical list mode — not horizontal bands.
const EXEMPT = /\.project-rail|\.space-tabs\.vertical/;

// Chrome row band (tab/header strip on the horizontal line under the title bar). Only theme standard
// variables own the height (--chrome-row-h=tab row, --header-h=title bar/view tab row). No hardcoded
// px. \.project-tabs does not match .space-tabs/.tabs.
const CHROME_ROW = /\.(ft-header|plugin-side-head|sidebar-left-tabs|space-tabs|project-tabs)(?![\w-])/;
// Allowed standard variables (both theme-owned) — a chrome row height is var() of one of them.
// Sanctioned row-height tokens — chrome-row (one band row), header (panel/rail header), toolbar
// (shared two-row grid, theme-owned). Do not invent a row height outside these three.
const CHROME_HEIGHT_OK = /height\s*:\s*var\(--(chrome-row|header|toolbar)-h/;

/** Is this selector listed in the contract — **there is exactly one judge.**
 *
 * A class name has an end. `.sidebar-left-header` starting with `.sidebar-left` does not put it under
 * that rule — a different name is a different surface, and one the contract does not have. Measured
 * 2026-08-15: substring matching let this gate pass while runtime `ui.expect` answered "no rule" for
 * the same selector. When the static gate and the verifier split, the static gate is the silent one.
 */
async function inContractJudge(): Promise<(selector: string) => boolean> {
  const { BORDER_RULES } = await import("./borderContract");
  const heads = BORDER_RULES.flatMap((rule) =>
    rule.selector.split(",").map((one) => one.trim().split(":")[0]),
  );
  return (selector: string) =>
    heads.some((head) => {
      const at = selector.indexOf(head);
      if (at < 0) return false;
      // A character continuing after the name means this is a different name.
      const after = selector[at + head.length];
      return after === undefined || !/[\w-]/.test(after);
    });
}

describe("UI alignment constitution gate (docs/UI.md)", () => {
  it("R1: a band item declares no height (auto only) — the strip padding owns the spacing", () => {
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      if (!BAND_ITEM.test(selector) || EXEMPT.test(selector)) continue;
      const heights = decls.match(/(?:^|;)\s*height\s*:\s*([^;]+)/g) ?? [];
      for (const h of heights) {
        if (!/height\s*:\s*auto/.test(h)) {
          violations.push(`${selector} → ${h.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("R1c: the rail frame header follows the pane grid row contract — height --header-h, top --pane-inset", () => {
    // The rail is furniture inside the pane grid — its neighbor is the pane group header, not the
    // chrome row (37px). Height and top offset must follow the theme variables
    // (--header-h/--pane-inset) for the vertical grid to line up exactly in every theme (no
    // hardcoding, no chrome row variables).
    const header = rules().find((r) => r.selector === ".projection-header");
    expect(header?.decls).toMatch(/height\s*:\s*var\(--header-h/);
    const host = rules().find((r) => r.selector === ".sidebar-left");
    expect(host?.decls).toMatch(/padding-top\s*:\s*var\(--pane-inset/);
  });

  it("§12-④ travel sync: a railGap consumer uses the same FLIP transform with no layout interpolation", () => {
    // left/width interpolation triggers per-panel layout and paint, tearing intermediate frames.
    // The final layout is committed first, then every railGap consumer returns via the same
    // compositor translate.
    const consumers = new Set(
      rules()
        .filter((r) => /var\(--rail-dx/.test(r.decls))
        .map((r) => r.selector.split(",")[0].trim().split(" ").pop() as string),
    );
    consumers.add(".pane-gutter"); // inline style consumer (GroupArea)
    // The structural frame consumes railGap coordinates but is not a motion representation. It is
    // removed on the moving pane and recreated at the settled rect, so it stays out of the FLIP
    // consumer set.
    consumers.delete(".pane-border");
    const sync = rules().find(
      (r) =>
        r.selector.startsWith(".space-body.rail-traveling") &&
        r.selector.includes(".pane"),
    );
    expect(sync).toBeTruthy();
    for (const sel of consumers) {
      expect(sync!.selector).toContain(sel);
    }
    expect(sync!.decls).not.toMatch(/transition\s*:/);
    // This line means the declaration and the CSS use the same single value — a human picks the value.
    expect(RAIL_TRAVEL_MS).toBe(180);
    expect(sync!.decls).toMatch(/animation:\s*rail-flip-x var\(--rail-travel-ms\) cubic-bezier\(0\.4, 0, 0\.2, 1\)/);
    // Travel distance composes in one variable (--flip-x) — adding the two axes in CSS drifts in the
    // phase where an array swap overlaps travel (the resolver folds them into px).
    const keyframes = css.match(/@keyframes rail-flip-x\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(keyframes).toMatch(/from\s*\{\s*transform:\s*translateX\(var\(--flip-x/);
    expect(keyframes).toMatch(/to\s*\{\s*transform:\s*translateX\(0px\)/);
    expect(css).not.toMatch(/--rail-flip-x/);
    expect(css).not.toMatch(/--focus-flip-x/);
    // The structural frame and the focus boundary are both state ownership. The moving pane's
    // previous boundary is removed and recreated at the commit position, so no frame is a FLIP
    // consumer.
    expect(sync!.selector).not.toContain(".pane-border");
    expect(sync!.selector).not.toContain(".pane-focus-boundary");
    expect(css).toMatch(/\.pane-focus-boundary\s*\{/);
    // Decorative spans follow the same rule — promote only what actually moves.
    expect(sync!.selector).toContain(".pane-gutter.flip-move");
    expect(sync!.selector).toContain(".drop-ind-wrap.flip-move");
    expect(sync!.selector).not.toMatch(/\.pane-gutter\s*\{/);
    // The rail keeps its DOM identity but its visual surface is removed during travel. No
    // intermediate frame where the rail crosses the screen over the native TabView, or appears
    // before the destination pane, is allowed.
    expect(sync!.selector).not.toContain(".sidebar.flip-move");
    expect(css).toMatch(/\.sidebar\[data-rail-role="traveling-hidden"\]\s*\{[^}]*visibility:\s*hidden/);
  });

  it("§5.1-F7 there is exactly one phase class — switching is the same single phase as travel", () => {
    // Two phase trackers (rail travel, panel swap) read different start points when one click
    // overlaps both, and drift. The arrangement resolver solves both axes in one solution, so there
    // is one class.
    expect(css).not.toMatch(/focus-layout-traveling/);
  });

  it("§12-④ the pane shrink and expand shows the region handover, with no fade and no rail overlay", () => {
    expect(css).not.toMatch(/@keyframes proj-slot-(in|out)/);
    expect(css).not.toMatch(/\.projection\.(entering|leaving)/);
    const rail = rules().find((r) => r.selector === ".sidebar");
    expect(rail?.decls).not.toMatch(/opacity\s*:/);
    const restingPlane = rules().find((r) => r.selector === ".left-rail-plane");
    const spacePlane = rules().find((r) => r.selector === ".space-plane");
    expect(restingPlane?.decls).toMatch(/z-index\s*:\s*0/);
    expect(spacePlane?.decls).toMatch(/z-index\s*:\s*1/);
    // The departing and the arriving rail keep the same layer contract.
    expect(css).not.toMatch(/\.space-body\.rail-traveling \.left-rail-plane\s*\{/);
  });

  it("the left rail is below the tabview work plane and only the relation line stays above both", () => {
    expect(focusVeilStackingViolations(css)).toEqual([]);
  });

  it("project and rail are global chrome above the DOM browser content stack", () => {
    expect(projectRailStackingViolations(css)).toEqual([]);
  });

  it("pins the spot where the rule actually splits — plant a violation and confirm the gate bites", () => {
    const raisedRail = css.replace(
      /\.left-rail-plane\s*\{[^}]*\}/,
      ".left-rail-plane { position: absolute; z-index: 2; }",
    );
    // Matched on the prefix that names the two planes and their z values. The
    // clause after the dash is prose and moves into the key table; toContain on
    // an array is an exact element match, so it cannot hold a fragment.
    expect(focusVeilStackingViolations(raisedRail)
      .some((v) => v.startsWith(".left-rail-plane: z-index 2 >= .space-plane 1"))).toBe(true);

    // Declaring the layer without positioning creates no stacking context, so content leaks outside
    // the plane.
    const unpositioned = css.replace(
      /\.space-plane\s*\{[^}]*\}/,
      ".space-plane { z-index: 1; }",
    );
    expect(focusVeilStackingViolations(unpositioned)
      .some((v) => v.startsWith(".space-plane: z-index 1"))).toBe(true);

    // A dead oracle (the reference plane gone) is a violation too.
    expect(focusVeilStackingViolations("")).not.toEqual([]);
  });

  it("§12-④ amended: input stays open during travel — no hit blocking on cells, slots, or dividers", () => {
    // Measured (focus trace): inertness during travel (whole surface, or moving elements only — rail
    // travel pushes every cell behind the station, so effectively the whole surface) dropped real
    // clicks arriving mid-travel onto space-body and killed them, and redelivery went to the
    // previous/first pane, producing "focus does not go where I clicked". Straddle prevention is
    // handled by activation attribution, not hit blocking (armSlotActivation — activation is
    // attributed at gesture completion to the slot that started the gesture). So no travel phase
    // blocks the input surface.
    for (const scope of [".space-body.rail-traveling"]) {
      const blocking = rules().filter(
        (r) =>
          r.selector.includes(scope) &&
          /pointer-events\s*:\s*none/.test(r.decls) &&
          /(pane|tab-body|pane-gutter)/.test(r.selector),
      );
      expect(blocking.map((b) => b.selector), scope + " must not block input").toEqual([]);
    }
  });

  it("toolbar row contract: the core toolbar (.fv-toolbar) consumes theme tokens — no reinvented dimensions", () => {
    // Feature top bars each invented their own dimensions and the grid drifted (measured: browser,
    // editor, and kanban rows all differed). Contract: a toolbar is optional, but where it exists it
    // consumes var(--toolbar-h)/var(--toolbar-pad-x). The core built-in surface (file viewer) is the
    // first conformer.
    const rule = rules().find((r) => r.selector.split(",").some((s2) => s2.trim() === ".fv-toolbar"));
    expect(rule).toBeTruthy();
    expect(rule!.decls).toMatch(/height:\s*var\(--toolbar-h\)/);
    expect(rule!.decls).toMatch(/padding:\s*0\s*var\(--toolbar-pad-x\)/);
    expect(rule!.decls).not.toMatch(/height:\s*\d/);
  });

  it("R1: no dead variable (--tab-h/--ws-tab-h) left behind — the contract variable is padding only", () => {
    expect(css).not.toMatch(/--tab-h\b|--ws-tab-h\b/);
  });

  it("R2: no position-correction hack on a tab-like item (negative offset, translateY, scale)", () => {
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      if (!BAND_ITEM.test(selector) || EXEMPT.test(selector)) continue;
      if (/(?:^|;)\s*(top|right|bottom|left)\s*:\s*-/.test(decls)) {
        violations.push(`${selector} → negative offset`);
      }
      if (/transform\s*:\s*[^;]*(translateY|scale)/.test(decls)) {
        violations.push(`${selector} → transform tweak`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("R1 contract rules exist: the strip consumes the padding variable and the item consumes stretch", () => {
    // Each band strip consumes its own padding variable.
    expect(css).toMatch(/\.tabs \{[^}]*padding: var\(--tab-pad/);
    expect(css).toMatch(/\.space-tabs \{[^}]*padding: var\(--ws-pad/);
    expect(css).toMatch(/\.project-tabs \{[^}]*padding-block: var\(--ws-pad/);
    // Block contract that stretches every item.
    expect(css).toMatch(
      /\.tabs \.tab,\s*\.tabs \.tab-add,\s*\.project-tab,\s*\.space-tab,\s*\.project-tab-add,\s*\.space-tab-add \{[^}]*align-self: stretch/,
    );
  });

  // ── R3/R4: chrome row height standard — every top-positioned band owns the single variable
  //    --chrome-row-h so the left sidebar tab band and the content tab band sit on the same line at
  //    the same height (the theme owns the value = per-theme standard).
  //    Do not weaken this test when something falls short — fix the CSS of the drifting band to the
  //    standard (no betrayal). ──
  it("R3: a chrome row band height is the standard var(--chrome-row-h) only — no hardcoded px", () => {
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      if (!CHROME_ROW.test(selector) || EXEMPT.test(selector)) continue;
      // Strip comments — a ';' or 'height' inside a comment breaks the (?:^|;) anchor and produces
      // false hits or misses.
      const clean = decls.replace(/\/\*[\s\S]*?\*\//g, "");
      const heights = clean.match(/(?:^|;)\s*height\s*:\s*([^;]+)/g) ?? [];
      for (const h of heights) {
        if (!CHROME_HEIGHT_OK.test(h)) {
          violations.push(`${selector.replace(/\s+/g, " ")} → ${h.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("R4: the panel chrome height variables are defined — --chrome-row-h, --header-h, --status-h (undefined breaks var())", () => {
    const missing: string[] = [];
    for (const v of ["--chrome-row-h", "--header-h", "--status-h"]) {
      if (!new RegExp(`${v}\\s*:`).test(css)) missing.push(v);
    }
    expect(missing).toEqual([]);
  });

  it("B4: no literal color (rgba/hex) in a border declaration — tokens (var(--bd*)) or transparent only", () => {
    // Ownership constitution (docs/UI.md §B4): structural line color is only the two tokens
    // --bd/--bd-soft. Only border* declarations are checked, not outline/box-shadow (accent surfaces
    // use the --accbg token).
    const violations: string[] = [];
    for (const { selector, decls } of rules()) {
      const borders =
        decls.match(/(?:^|;)\s*border[^:;]*:\s*[^;]+/g) ?? [];
      for (const b of borders) {
        if (/rgba?\(|#[0-9a-fA-F]{3}/.test(b)) {
          violations.push(`${selector} → ${b.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("B4: the derived token --bd-soft is defined (single source of the inner line tone)", () => {
    expect(css).toMatch(/--bd-soft:\s*color-mix\(/);
  });

  // ── §B8 contract exhaustiveness: a seam the spec does not have is a seam the spec cannot catch —
  //    so the gate enforces two-way sync between "structural borders in CSS" and the contract table.
  //    A selector that draws a structural border (--bd/--bd-soft) must be listed in the contract, or
  //    be explicitly classified as a "widget outline" that is not a seam. ──

  // Widget outline (non-seam) allowlist — closed outlines such as inputs, cards, badges, swatches.
  // Not a seam (a dividing line between two regions), so not subject to the ownership contract.
  const WIDGET_OUTLINE = [
    ".plugin-input",
    ".plugin-row",
    ".plugin-badge",
    ".settings-input", // settings input box (number/text) — closed outline
    ".settings-select", // settings dropdown — closed outline
    ".settings-list-add", // settings list add button — closed outline
    ".settings-list-remove", // settings list remove button — closed outline
    ".plugin-consent-item",
    ".plugin-consent-notice",
    ".dremote-confirm-notice", // remote confirm auto-refusal notice box — closed outline (not a seam)
    ".plugin-consent-cmd", // raw command code box — closed outline
    ".plugin-contrib-chip", // role chip — closed outline
    ".pane-status-item", // status bar plugin item chip ("gui" of claude-GUI, for example) — closed outline
    ".notify-banner", // in-app notification banner card + action button (-action) — closed outline
    ".webview-health-badge", // webview recovery exhausted badge card + button — closed outline (same shape as notify-banner)
    ".boot-phase", // boot phase badge (restore and plugin readiness progress) — closed pill outline (same shape as webview-health-badge)
    ".root-missing-banner", // missing root degradation banner (B1) — banner card outline (same shape as notify-banner)
    ".motion-debug", // motion observation panel card (development only) — closed outline (not a seam)
    ".motion-debug button", // that panel's speed and stop buttons — closed outline
    ".orch-win", // orchestrator window map item card (A3) — closed outline
    ".orch-console input", // orchestrator console input — closed outline
    ".orch-console button", // orchestrator run button — closed outline
    ".orch-feed-all", // feed all-filter clear button — closed outline
    ".left-rail-controls", // closed control palette around the FLOW/PIN grip and pin

    ".dctl",
    ".dstepper",
    ".th-item",
    ".th-swatch",
    ".color-swatch",
    ".rail-add",
    ".plugin-rejected",
    ".space-tab-rename",
    ".project-tab-rename",
    ".rail-rename",
    ".bv-url",
    ".cmf-input",
    ".cmf-field",
    ".icon-btn",
    ".drop-ind",
    ".tab", // chip outline (theme variant) — the chip's own closed curve
    ".project-tab",
    ".space-tab",
    ".dbtn",
    ".rail-chip",
  ];

  it("B8: a structural border selector is listed in the contract or classified as a widget outline — no unknown seam", async () => {
    const inContract = await inContractJudge();
    const isWidget = (selector: string) =>
      WIDGET_OUTLINE.some((w) => selector.includes(w));

    const unknown: string[] = [];
    for (const { selector, decls } of rules()) {
      const borders = decls.match(/(?:^|;)\s*border[^:;]*:\s*[^;]+/g) ?? [];
      const structural = borders.filter((b) => /var\(--bd(-soft)?\)/.test(b));
      if (structural.length === 0) continue;
      for (const single of selector.split(",").map((s) => s.trim())) {
        if (!inContract(single) && !isWidget(single)) {
          unknown.push(`${single} → ${structural[0].trim()}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("B8: the listing verdict uses the whole class name — a shared prefix does not cover a different surface", async () => {
    // `.sidebar-left-header` starts with `.sidebar-left`. Substring matching lets a new surface that
    // is not in the contract pass under an already-listed neighbor's rule — measured 2026-08-15:
    // this gate passed while runtime `ui.expect` answered "no rule" for the same selector. When the
    // two split, the static side is the silent one.
    //
    // A contract selector with characters appended after it is a **different surface**, and the gate
    // must treat it as unknown. This uses the same judge as the check above — with two judges this
    // check measures nothing.
    const { BORDER_RULES } = await import("./borderContract");
    const contractSelectors = BORDER_RULES.flatMap((r) =>
      r.selector.split(",").map((one) => one.trim()),
    );
    const covered = contractSelectors.find((one) => one.startsWith("."));
    expect(covered, "the contract has no class selector at all").toBeDefined();

    const inContract = await inContractJudge();
    const head = (covered as string).split(":")[0];
    expect(inContract(head)).toBe(true);
    expect(inContract(`${head}-probe`)).toBe(false);
  });

  it("B8 exhaustiveness: a conditional surface covers the state space with no gap and no contradiction", async () => {
    // Asserting only the "state that must exist" and leaving the opposite state empty means a line
    // that must not exist produces no RED — for a (selector, edge/seam) unit with a conditional
    // (when) rule, every paneStyle×gutter combination must be covered by exactly one rule.
    const { BORDER_RULES } = await import("./borderContract");
    const PANE = ["flat", "card", "floating"];
    const DIV = ["overlay", "solid"];
    type Key = string; // `${selector}|${edge}`
    const targets = new Map<Key, { rule: string; when?: { paneStyle?: readonly string[]; gutter?: readonly string[] } }[]>();
    for (const r of BORDER_RULES) {
      const edges = r.kind === "seam" ? ["seam"] : Object.keys(r.edges ?? {});
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        for (const e of edges) {
          const k = `${sel}|${e}`;
          if (!targets.has(k)) targets.set(k, []);
          targets.get(k)!.push({ rule: r.id, when: r.when });
        }
      }
    }
    const problems: string[] = [];
    for (const [key, rs] of targets) {
      // Unconditional rules alone cover every state — pass.
      if (rs.every((r) => !r.when)) {
        if (rs.length > 1) problems.push(`${key}: duplicate unconditional rule (${rs.map((r) => r.rule)})`);
        continue;
      }
      for (const p of PANE) {
        for (const d of DIV) {
          const hits = rs.filter(
            (r) =>
              (!r.when?.paneStyle || r.when.paneStyle.includes(p)) &&
              (!r.when?.gutter || r.when.gutter.includes(d)),
          );
          if (hits.length === 0) {
            problems.push(`${key}: state gap paneStyle=${p},gutter=${d}`);
          } else if (hits.length > 1) {
            problems.push(
              `${key}: state contradiction paneStyle=${p},gutter=${d} → ${hits.map((h) => h.rule).join(",")}`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("B8: every edges rule in the contract has a matching CSS declaration (no vacuous rule)", async () => {
    const { BORDER_RULES } = await import("./borderContract");
    const empty: string[] = [];
    for (const r of BORDER_RULES) {
      if (r.kind !== "edges" || !r.edges) continue;
      const tokens = Object.values(r.edges).filter((v) => v !== "none");
      if (tokens.length === 0) continue; // for a none assertion, the absence of a declaration is the right answer
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        // A selector is not a regex — escape all of it. The version that escaped only the leading
        // dot read an attribute selector ([data-station="0"]) as a character class and found no
        // matching declaration.
        const head = sel.split(":")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`${head}[^{]*\\{[^}]*border[^:;]*:[^;]*var\\(--bd`);
        if (!re.test(css)) empty.push(`${r.id} (${sel})`);
      }
    }
    expect(empty).toEqual([]);
  });
});
