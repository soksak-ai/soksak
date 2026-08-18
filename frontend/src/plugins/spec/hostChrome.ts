// §Chrome standard gate — static scan of a plugin entry (bundle).
// The host solely owns the height and layout of the chrome row band (tabs/header) (per-theme
// --chrome-row-h standard). A bundle that overrides those selectors or variables from its own plugin
// CSS violates the contract — scan the entry source before load and reject obvious violations at the
// authoring boundary. The runtime security boundary is an opaque sandbox, so host DOM access is
// impossible to begin with; this static gate does not replace the security boundary, it is an
// authoring/conformance diagnostic that explains the defect earlier.

// Chrome selectors and variables the host solely owns. Appearing in plugin CSS is a violation (a plugin must style only its own body slot).
export const HOST_CHROME_TOKENS: readonly string[] = [
  ".sidebar-body-tabs",
  ".sidebar-body-tab",
  // Chrome vocabulary migration window (IDENTITY 2026-07-26) — guard both the old and the new
  // names. Guarding only one leaves a plugin unprotected when it meets a core of the other
  // generation. Removal condition: the day a core that draws the old names drops out of the
  // support range (strip only the old token rows).
  ".content-tabs",
  ".space-tabs",
  ".view-tabs",
  ".view-tab",
  // `.tab` and `.tabs` are not listed here — this scanner is a heuristic and cannot distinguish a
  // JS property access (`this.tab()`) from a CSS selector, so it false-positives
  // on valid bundles (real incident 2026-07-26: terminal plugin activation was rejected outright).
  // Chrome ownership of those two names is enforced by the core CSS cascade and the cssVocabulary
  // gate, not by the scanner.
  ".pane-tabs",
  ".workspace-tabs",
  ".workspace-tab",
  ".ft-header",
  ".plugin-side-head",
  ".titlebar",
  "--chrome-row-h",
  "--header-h",
  "--status-h",
];

// Finds host chrome token violations in the entry source. Only a CSS context (an assignment followed
// by { or :) counts as a violation — so comments and prose mentions do not false-positive.
// Returns the list of tokens found (empty array = pass).
export function scanHostChromeViolations(entrySource: string): string[] {
  const hits: string[] = [];
  for (const tok of HOST_CHROME_TOKENS) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Selector: appears at a rule head plus a declaration block, as in `.sidebar-body-tabs {` / `.sidebar-body-tabs.foo,`.
    // Variable: a definition/assignment, as in `--chrome-row-h:`.
    const re = tok.startsWith("--")
      ? new RegExp(`${esc}\\s*:`)
      : new RegExp(`${esc}(?![\\w-])[^{}\`]*\\{[^}]*:`);
    if (re.test(entrySource)) hits.push(tok);
  }
  return hits;
}
