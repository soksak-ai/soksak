/** Chrome bands of one window — **the only place this value is defined.**
 *
 * The header is the same height everywhere and so is the footer. If the sidebar and the content each hold
 * their own value, two bands standing side by side land one pixel apart, and that offset looks different per
 * theme — it reads as one theme's problem while being no theme's problem.
 *
 * Measured 2026-08-15: content header 33px, sidebar header 30px, content footer 24px, sidebar footer absent.
 * The owner of the value was split between a CSS variable fallback and a JS constant, with no link between them.
 *
 * Code owns it per docs/tech/UI-GEOMETRY.md R4 — a dimension constant is injected once, from one place.
 * A theme sets size through the R1 padding knobs (--tab-pad/--ws-pad), not through this value; band height is
 * derived there as `padding + item + padding + line`. So a theme sets size yet cannot make the sidebar and the
 * content disagree — the derivation gives both the same answer.
 *
 * When the knobs are not enough, add a slot (R3a). Do not let a theme override this constant directly.
 */
export const CHROME_BANDS = {
  /** Header — content view-tab row, sidebar tab row, top band of a plugin view. */
  header: 33,
  /** Footer — content status bar, sidebar status bar. */
  footer: 24,
} as const;

/** The form handed to CSS. A place that uses a band reads only these variables and never re-types the number. */
export function chromeBandVariables(): Record<string, string> {
  return {
    "--header-h": `${CHROME_BANDS.header}px`,
    "--status-h": `${CHROME_BANDS.footer}px`,
  };
}
