// Identity vocabulary rule (single truth) — the banned-word judgment for every name exposed to the
// DOM (CSS classes, data-* attributes).
//
// Rule (docs/IDENTITY.md §3·§5): one entity, one name. A banned word cannot appear as a morpheme
// in any DOM name, core or plugin. This list and this judgment exist in exactly one place — the
// core gates (domVocabulary·cssVocabulary), the publish gate (doctor) and plugin conformance all
// consume the same function. A duplicated copy of the list diverges (real incident: only the core
// was counted and the plugins were polluted).
//
// Why morphemes: an exact-match ban table misses variants (data-panel-id, .my-divider-line) —
// tokenize the name on hyphen and camel boundaries, and one banned morpheme is a violation. A
// rule, not an enumeration.

/** Morphemes banned in DOM names — IDENTITY §3 banned words plus every §5-1 wrapper role noun (not
 *  up for re-argument). Partial adoption is a sloppy rule — this table always matches the
 *  document's ban list exactly. */
export const BANNED_DOM_MORPHEMES: readonly { morpheme: string; canonical: string }[] = [
  // §3 banned words
  { morpheme: "panel", canonical: "pane" },
  { morpheme: "egroup", canonical: "pane" },
  { morpheme: "group", canonical: "pane" },
  { morpheme: "divider", canonical: "gutter" },
  { morpheme: "bodywrap", canonical: "space-body" },
  // §5-1 wrapper role nouns — they hide the entity behind an alias
  { morpheme: "slot", canonical: "(entity name + -body, or another part derivation)" },
  { morpheme: "cell", canonical: "pane" },
  { morpheme: "grid", canonical: "space" },
  { morpheme: "frame", canonical: "(entity name — frame collides with the render frame)" },
  { morpheme: "container", canonical: "(entity name + -body)" },
  { morpheme: "leaf", canonical: "pane" },
  { morpheme: "host", canonical: "(entity name + -body)" },
  { morpheme: "handle", canonical: "gutter (drag), or the entity part name" },
];

/** Externally owned DOM names — a name defined and published by an external library or standard is
 *  not our naming. We hold no authority to rename it (the library publishes it) and banning it
 *  would rule out that ecosystem entirely, so it is excluded from the banned-word judgment. Same
 *  principle as the existing core allow table (data-testid "external standard name",
 *  data-tauri-drag-region "externally owned").
 *
 *  This table is an ownership record, not an exemption window — entry conditions:
 *  ① State the owner (library or standard). ② The pattern covers exactly that library's real
 *  grammar (no wide prefix opening — grid-cols-N, not all of grid-*). ③ A name denoting one of our
 *  entities must not be listed even when it has an owner (that is an alias, not external
 *  vocabulary). */
export const EXTERNAL_DOM_NAMES: readonly { pattern: RegExp; owner: string }[] = [
  { pattern: /^grid$/, owner: "Tailwind CSS — display:grid utility" },
  { pattern: /^(grid-cols|grid-rows)-\d+$/, owner: "Tailwind CSS — grid template utility" },
  { pattern: /^group$/, owner: "Tailwind CSS — group variant marker" },
  {
    pattern: /^group-(hover|focus|focus-within|focus-visible|active|disabled|odd|even|first|last)$/,
    owner: "Tailwind CSS — group variant prefix",
  },
  { pattern: /^cmdk-[a-z-]+$/, owner: "cmdk — class the component itself publishes" },
  { pattern: /^data-slot$/, owner: "shadcn/ui — component contract attribute" },
];

/** External ownership check — the owner string on a match, otherwise null. */
export function externalDomOwner(name: string): string | null {
  for (const { pattern, owner } of EXTERNAL_DOM_NAMES) {
    if (pattern.test(name)) return owner;
  }
  return null;
}

/** Splits a name into morphemes — hyphen, underscore and camel boundaries. "data-panel-id" → [data,panel,id]. */
export function domNameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Banned-word judgment for a DOM name (class or data-* attribute name).
 * The reason string on a violation, otherwise null. Morphemes containing another banned word, such
 * as egroup, are matched longest first (avoids a partial-match misjudgment — token granularity
 * makes it an exact match in practice).
 * Externally owned names (EXTERNAL_DOM_NAMES) pass before the judgment — they are not our naming.
 */
export function bannedDomName(name: string): string | null {
  if (externalDomOwner(name) !== null) return null;
  const tokens = domNameTokens(name);
  for (const { morpheme, canonical } of BANNED_DOM_MORPHEMES) {
    if (tokens.includes(morpheme)) {
      return `"${name}" contains the banned morpheme "${morpheme}" — canonical vocabulary: ${canonical}`;
    }
  }
  return null;
}
