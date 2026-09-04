// Plane fixtures for tests: a space's panes laid out through the same library the store uses.
//
// Built in a box of their own, so a fixture declared at collection time (in a describe body,
// before any beforeEach) lays out the same as one built in a test. A plane state is normalised,
// so a fixture built here reads correctly in whatever box a test then sets.
import { singlePane, splitPane, type PlaneBox, type PlaneState, type Side } from "../state/panePlane";
import type { Pane, Space } from "../state/sessions";

export const FIXTURE_BOX: PlaneBox = { width: 1200, height: 800, gap: 0 };

/** A plane built by splitting, in order: each step puts `id` on `side` of `of`. */
export function planeOf(
  first: string,
  ...steps: Array<{ id: string; side: Side; of: string }>
): PlaneState {
  let state = singlePane(first);
  for (const step of steps) {
    const next = splitPane(state, FIXTURE_BOX, step.of, step.side, step.id);
    if (!next) throw new Error(`the plane refused ${step.id} ${step.side} of ${step.of}`);
    state = next;
  }
  return state;
}

/** Panes side by side, left to right. */
export function rowPlane(ids: readonly string[]): PlaneState {
  return planeOf(ids[0], ...ids.slice(1).map((id, i) => ({ id, side: "right" as const, of: ids[i] })));
}

/** Panes stacked, top to bottom. */
export function columnPlane(ids: readonly string[]): PlaneState {
  return planeOf(ids[0], ...ids.slice(1).map((id, i) => ({ id, side: "bottom" as const, of: ids[i] })));
}

/** A space over these panes, laid out side by side unless a plane is given. */
export function spaceOf(
  id: string,
  panes: Pane[],
  layout: PlaneState = rowPlane(panes.map((g) => g.id)),
  extra: Partial<Space> = {},
): Space {
  return { id, title: id, panes, layout, activePaneId: panes[0]?.id ?? "", ...extra };
}
