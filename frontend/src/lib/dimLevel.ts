// A surface's dim is one level.
//
// There are several reasons to dim — not focused (idle), or wedged between the rail and the focused
// pane (blocked). Only one value is painted. One CSS rule per reason lets specificity pick that one
// value: the darker level loses to the lighter one, and nothing fails, so nobody sees it.
//
// Incident 2026-08-02: `.space[data-focus-dim] .tab-body.hole::after` (4 classes) beat
// `.tab-body.hole.rail-blocked::after` (3 classes), so the wedged pane's veil painted at 7% instead
// of 22% — the same value as idle. The code was there and the checks passed, the screen did not change.
//
// So the level is fixed here. One name (`data-dim`) goes out to the surface, and CSS draws one rule
// per name. With no place for rules to compete, there is no specificity accident.

/** Dim level — goes out to the surface as `data-dim`. The result, not the reason. */
export type DimLevel = "clear" | "idle" | "blocked";

/** Reasons to dim — they come in here and one level goes out. */
export type DimInput = {
  /** Is this pane focused. */
  active: boolean;
  /** Setting that sinks whatever is not focused (focusDim). */
  focusDim: boolean;
  /** Is this pane wedged between the rail and the focused pane, the rail stopping short of it. */
  blocked: boolean;
};

/**
 * Picks one level out of the reasons.
 *
 * Focused never dims — it is the one picked to look at. A wedged pane dims regardless of `focusDim`:
 * "blocked" is a fact of the rail axis, not of the dim setting, and turning the setting off does not
 * remove the occlusion. Wedged is darker than idle — at the same value "blocked" is invisible.
 */
export function dimLevel({ active, focusDim, blocked }: DimInput): DimLevel {
  if (active) return "clear";
  if (blocked) return "blocked";
  return focusDim ? "idle" : "clear";
}

/** Is this level actually dimmed — so "not clear" is not rewritten at every call site. */
export function isDimmed(level: DimLevel): boolean {
  return level !== "clear";
}

/** Strength per level — set by the user (settings). One value, so both media read the same thing. */
export type DimAmounts = { idle: number; blocked: number };

/**
 * How far this level sinks the surface (0..1).
 *
 * Name (level) and strength (value) are separate axes: the name fixes "why it dims", the value fixes
 * "how much". The value goes down to the surface, so CSS writes no number — a number there would not
 * change when the user changes the setting.
 */
export function dimAmount(level: DimLevel, amounts: DimAmounts): number {
  if (level === "blocked") return amounts.blocked;
  if (level === "idle") return amounts.idle;
  return 0;
}
