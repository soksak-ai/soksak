// Theme variable contract — the set of CSS custom properties the skeleton guarantees to plugins
// (single truth). The sources are the core theme engine and App.css; they are imported or listed here
// (never duplicated elsewhere). Plugin CSS that references var(--X) outside this set gets no value
// under that name from the core, so it paints the fallback color and the theme does not apply (a
// silent visual bug). findGhostThemeVars catches that mismatch mechanically.
import { moduleState } from "../lib/moduleState";
import { COLOR_SLOTS } from "../theme/engine";

// Variables the engine sets with setProperty beyond the slots (engine.ts applyThemeToDom) + App.tsx.
const ENGINE_EXTRA_VARS = ["glow", "scan", "amb", "pane-pad", "app-font", "app-font-size"] as const;

// Variables App.css declares statically on :root (layout dimensions included). Source: src/App.css.
// Includes every static variable a plugin may legitimately reference, not only colors and fonts.
const STATIC_CSS_VARS = [
  "bd-soft", "danger", "danger-soft",
  "chrome-row-h", "header-h", "status-h", "tab-pad", "ws-pad",
  "fk-bot", "fk-len", "fk-th", "fk-top", "trees-padding-inline-override",
] as const;

// The full set of theme/style variable names the core guarantees (without the "--" prefix).
export const CORE_THEME_VARS: ReadonlySet<string> = new Set<string>([
  ...COLOR_SLOTS,
  ...ENGINE_EXTRA_VARS,
  ...STATIC_CSS_VARS,
]);

// Host theme "semantic vocabulary" — the roots of semantic names a plugin uses expecting a core token
// (or by mistake). The ghost verdict is limited to this vocabulary: library and private namespaces
// (radix-*, trees-*, color-blue-500, gap …) are outside it and are not checked (avoids false
// positives). A name inside the vocabulary that the core does not provide = a real bug.
// Example: text/surface/accent/border/background/foreground/hover/bg2 -> the core has only fg/card/acc/bd/bg.
// Outside the hot-swap boundary — if this table became new, the side that filled it would treat it as already filled and not fill it again.
const HOST_THEME_VOCAB: ReadonlySet<string>  = moduleState("plugins/themeContract#HOST_THEME_VOCAB", () => new Set<string>([
  "bg", "fg", "text", "foreground", "background", "surface", "card", "panel",
  "side", "sidebar", "inset", "bd", "border", "acc", "accent", "accbg", "ok",
  "success", "shadow", "hover", "muted", "primary", "secondary", "danger",
  "warning", "error", "link", "ring", "focus", "selection", "highlight",
]));
// Serializable contract (Doctor consumes it as contract.json — published once by the core).
export function themeVarContract(): { vars: string[]; vocab: string[] } {
  return {
    vars: [...CORE_THEME_VARS].sort(),
    vocab: [...HOST_THEME_VOCAB].sort(),
  };
}

// Semantic root of a variable name — trailing digits and -digits removed (bg2->bg, text-2->text, surface-2->surface).
function themeRoot(name: string): string {
  return name.replace(/-?\d+$/, "");
}

// Whether the name intends a host theme token, that is, whether it is subject to the ghost check.
export function isHostThemeToken(
  name: string,
  vocab: ReadonlySet<string> = HOST_THEME_VOCAB,
): boolean {
  return vocab.has(name) || vocab.has(themeRoot(name));
}

// Returns the sorted "ghost" variables in a text (CSS, source, bundled main.js). Pure function — the same logic as Doctor.
// Ghost = referenced as var(--X) but (a) absent from the core contract, (b) not defined (--X:) by that
// same text, and (c) a name inside the host theme vocabulary — that is, "meant a core token the core
// does not provide". Self-defined variables (library and private tokens such as Tailwind, Radix,
// @pierre-trees) are not ghosts.
export function findGhostThemeVars(
  text: string,
  contract: ReadonlySet<string> = CORE_THEME_VARS,
): string[] {
  const defined = new Set<string>();
  for (const m of text.matchAll(/--([a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  const ghosts = new Set<string>();
  for (const m of text.matchAll(/var\(\s*--([a-z0-9-]+)/g)) {
    const v = m[1];
    if (!contract.has(v) && !defined.has(v) && isHostThemeToken(v)) ghosts.add(v);
  }
  return [...ghosts].sort();
}
