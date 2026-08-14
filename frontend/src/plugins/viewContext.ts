// View context axes — the single source of truth for which changes the view must react to.
//
// This decision used to be hand-wired inside PluginViewHost as a list of field names:
// root/viewId/command in the remount key, paneId in both update and remount, boundViewId in
// neither. A hand-written list silently omits new fields, and an omitted field shows up as "the
// binding changed but the screen is the old one" (measured 2026-07-31: the shared projection
// drew the previous view's content after a binding switch).
//
// There are two axes, and they point in opposite directions:
//   binding — value the core determines and passes to the view. A change must update the view.
//   seed    — one-time mount seed. The view writes it back itself (setRestoreState → restore),
//             so using a change as a trigger makes a report → recreate → report loop.
//             **Not a trigger.**
//
// A missing entry is blocked at compile time — the satisfies below requires every data field, so
// adding a data field to the contract breaks the build until its axis is written. This is rule
// enforcement, not a hand-written list.

import type { PluginViewContext } from "./viewRegistry";

/** Value fields, not callbacks (capabilities) — derived from the contract. Never listed by hand. */
export type ViewContextDataKey = {
  [K in keyof PluginViewContext]-?: PluginViewContext[K] extends (
    ...args: never[]
  ) => unknown
    ? never
    : K;
}[keyof PluginViewContext];

export type ViewContextAxis = "binding" | "seed";

export const VIEW_CONTEXT_AXIS = {
  projectId: "binding",
  root: "binding",
  paneId: "binding",
  viewId: "binding",
  boundViewId: "binding",
  command: "binding",
  // Value the view writes back with setRestoreState — using it as a trigger is a feedback loop (do not move it to binding).
  restore: "seed",
} as const satisfies Record<ViewContextDataKey, ViewContextAxis>;

/** Binding-axis fields — sorted and fixed (declaration order must not shift identity). */
export const BINDING_KEYS: readonly ViewContextDataKey[] = (
  Object.keys(VIEW_CONTEXT_AXIS) as ViewContextDataKey[]
)
  .filter((k) => VIEW_CONTEXT_AXIS[k] === "binding")
  .sort();

/**
 * Binding identity — when this value changes, the view must be updated.
 *
 * Measured by **value**, not by reference: even when the parent builds a new object every render,
 * identical content is the same binding (with reference comparison a harmless re-render would
 * become a remount storm).
 */
export function bindingIdentity(
  ctx: Pick<PluginViewContext, ViewContextDataKey>,
): string {
  return JSON.stringify(BINDING_KEYS.map((k) => ctx[k] ?? null));
}
