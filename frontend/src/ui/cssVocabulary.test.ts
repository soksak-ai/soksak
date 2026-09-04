// CSS namespace vocabulary gate — class and custom property names in App.css hold no deleted word.
//
// (a) The rule enforced — the single truth for the banned set is vocabulary standard §1-5 alone:
//     panel · group · egroup · content- (class prefix) · pane (old meaning = tab instance) ·
//     cell · grid · bodywrap · divider · view (instance meaning).
//     Retained words are not put on the list at all (§1-5 "no exception paragraph") —
//     content (public enum value) · slot (rail natural key) · container (qualifier form such as
//     `.tab-viewer`).
//     Two violations inside one name are both recorded (`.pane-panel` = pane + panel).
//
// (b) RED basis (measured, 2026-07-26) — of 430 class kinds and 52 property kinds, 48 classes
//     violate. `.egroup-*` 9 · `.view-*` 12 · `.plugin-view-*` 7 · `.pane-*` (old meaning) 5 ·
//     `.content-*` 3 · `.th-cell` `.th-grid` `.left-host-cell` `.left-host-grid`
//     `.settings-*-cell` and others.
//     Three names hold two dead words each: `.pane-panel` · `.pane-group` · `.content-pane`.
//     Custom properties: 0 kinds — the only one left in App.css is `--pane-inset`, and it still
//     means a pane (§1-4b: the new meaning stays valid). The property axis is GREEN now; it is
//     counted to stop a dead word from returning as a property later.
//
// (c) The shell queries that produced those counts:
//     grep -oE "\.[a-zA-Z][a-zA-Z0-9_-]*" src/App.css | sort -u | wc -l          # 430
//     grep -oE "\-\-[a-zA-Z][a-zA-Z0-9_-]*" src/App.css | sort -u | wc -l        # 52
//     Those queries also count text inside comments (`.pane` of `SKIN.pane`, `.tsx`, `.md` — 13
//     kinds). This gate strips comments before counting, so the class denominator is 417 — the
//     difference of 13 from 430 is comment noise. Making the denominator exact is not lowering the
//     standard: a word inside a comment is not a name, so it is nothing to fix.
//
// Test for the two words whose meaning splits (banning a token alone cannot split meaning — §2-2
// withdrew that claim):
//   pane  — alive in the new meaning (a pane). The test is the nature of the suffix (IDENTITY §5
//           correction 2026-07-26): entity derivations (`-gutter`, `-tabs`) and part names stated
//           by content (`-body`, `-border`, `-title`, `-status`) are allowed — a part name does
//           not hide the entity. Banned are **wrapper role nouns**: slot, cell, grid, frame,
//           container, leaf, host, handle, group, panel, which hide the entity behind a nickname.
//           The first edition narrowed the allowance to a 4-entry whitelist, which put the gate
//           ahead of the standard — corrected together with the canonical text (IDENTITY §5).
//           Properties name a value, not an element, so they fall outside this rule; only
//           `--pane-inset` is allowed.
//   view  — alive as a kind (`contributes.views` declared by a plugin). But CSS paints the entity
//           on screen, so `view` in a CSS name cannot be a kind — all of them carry the instance
//           meaning and all of them violate.
//
// Decided by exact segment match only — `webview` (§1-4d ② a different axis), `viewer`,
// `viewport`, and `2pane` are different tokens and are not flagged. `.hole-slot` is not a
// violation either: neither `slot` nor `hole` is on the §1-5 list.
// Never add a word that is not on the list — a gate ahead of the standard makes two standards.
// Never drop a word from the list because it fails, either. App.css is what gets fixed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BANNED_DOM_MORPHEMES } from "../plugins/spec";

/** A comment is not a name — strip comments, then count. */
const CSS = readFileSync(join(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const uniq = (xs: string[]) => [...new Set(xs)].sort();
const classNames = () => uniq([...CSS.matchAll(/\.[a-zA-Z][a-zA-Z0-9_-]*/g)].map((m) => m[0]));
const propNames = () => uniq([...CSS.matchAll(/--[a-zA-Z][a-zA-Z0-9_-]*/g)].map((m) => m[0]));

// The single truth for banned morphemes is the spec (plugins/spec identityVocabulary) — this file
// keeps no copy and consumes that list (a copy diverges — observed incident: the two core gates
// had different lists, so the host and frame families were flagged in only one of them).
const DEAD = BANNED_DOM_MORPHEMES.map((b) => b.morpheme);
const WRAPPER_ROLE_NOUNS = new Set(DEAD);
const PUBLIC_LIBRARY_CLASSES = new Set([".sp-divider"]);
const paneNameViolates = (name: string): boolean => {
  const segs = name.slice(1).split("-");
  if (!segs.includes("pane")) return false;
  return segs.some((sg) => WRAPPER_ROLE_NOUNS.has(sg));
};
/** Property alive in the new meaning — §1-4b. */
const PANE_PROP_ALIVE = new Set(["--pane-inset"]);

/** Dead words this name holds. Empty = not a violation. */
function deadWordsIn(name: string, kind: "class" | "prop"): string[] {
  if (kind === "class" && PUBLIC_LIBRARY_CLASSES.has(name)) return [];
  const segs = name.replace(/^(\.|--)/, "").split("-");
  const hit = DEAD.filter((w) => segs.includes(w));
  if (kind === "class" && segs[0] === "content" && segs.length > 1) hit.push("content-");
  if (segs.includes("pane")) {
    // Class: only a combination with a wrapper role noun violates (part names and entity
    // derivations are allowed — the test stated in the header).
    // Property: the axis names a value, so only --pane-inset is allowed (unchanged).
    const violates =
      kind === "class" ? paneNameViolates(name) : !PANE_PROP_ALIVE.has(name);
    if (violates) hit.push("pane");
  }
  if (segs.includes("view")) hit.push("view");
  return hit;
}

/** The line printed verbatim in the failure message — the name and the dead words it holds. */
const offenders = (names: string[], kind: "class" | "prop") =>
  names
    .map((n) => ({ name: n, dead: deadWordsIn(n, kind) }))
    .filter((x) => x.dead.length > 0)
    .map((x) => `${x.name} <- ${x.dead.join(",")}`);

describe("the App.css namespace uses only the live vocabulary", () => {
  it("names were actually scanned — an empty scan does not pass as a pass", () => {
    // Measured (2026-07-26): 417 class kinds (430 with the comment-inclusive query) · 52 property
    // kinds. The counts move during renaming, so only a lower bound is pinned. This blocks just
    // one thing: scanning 0 kinds and reporting "no violations".
    expect({
      classes: classNames().length >= 300,
      props: propNames().length >= 40,
    }).toEqual({ classes: true, props: true });
  });

  it("no class name holds a deleted word", () => {
    expect(offenders(classNames(), "class")).toEqual([]);
  });

  it("no custom property name holds a deleted word", () => {
    expect(offenders(propNames(), "prop")).toEqual([]);
  });
});

describe("the decision rule itself is pinned — the gate runs neither ahead of nor behind the standard", () => {
  it("a retained word is not a violation — content(enum) and entity or part derivations", () => {
    // Re-legislated (2026-07-27, unified on the spec as single truth): the old edition retained
    // slot (natural key) and container (qualifier form), but the document's standard bans all §5-1
    // wrapper nouns — slot survives only as a derived-key "concept" and is dead as a DOM name
    // (.hole-slot already moved to .tab-body.hole).
    const kept = [".content", ".tab-viewer", ".tab-body", ".pane-gutter"];
    expect(kept.filter((n) => deadWordsIn(n, "class").length > 0)).toEqual([]);
  });

  it("a different token is not mistaken for a dead word — webview · viewer · viewport", () => {
    const other = [".webview-health-badge", ".file-viewer", ".xterm-viewport"];
    expect(other.filter((n) => deadWordsIn(n, "class").length > 0)).toEqual([]);
  });

  it("two dead words in one name are both recorded", () => {
    expect(deadWordsIn(".pane-panel", "class").sort()).toEqual(["pane", "panel"]);
    expect(deadWordsIn(".content-cell", "class").sort()).toEqual(["cell", "content-"]);
  });

  it("only the new meaning of pane is retained — a newly coined role noun is a violation", () => {
    expect(deadWordsIn(".pane", "class")).toEqual([]);
    expect(deadWordsIn(".pane-body", "class")).toEqual([]);
    expect(deadWordsIn("--pane-inset", "prop")).toEqual([]);
    // Re-legislated (2026-07-27): leaf and handle joined the §5-1 full ban — counting two
    // violations is correct.
    expect(deadWordsIn(".pane-leaf", "class").sort()).toEqual(["leaf", "pane"]);
    expect(deadWordsIn(".pane-resize-handle", "class").sort()).toEqual(["handle", "pane"]);
  });

  it("every view in CSS has the instance meaning — a kind is not painted on screen", () => {
    expect(deadWordsIn(".view-tab", "class")).toEqual(["view"]);
    // Re-legislated (2026-07-27): container is under the §5-1 full ban too — both violations count.
    expect(deadWordsIn(".plugin-view-container", "class").sort()).toEqual(["container", "view"]);
  });
});
