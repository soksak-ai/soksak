// What the window spends its main thread on while the layout changes.
//
// Measured 2026-08-17: the window stops drawing for 75 to 105ms when focus moves between panes, on a
// machine that draws every 17ms once it is still. Nothing on the screen moves while the window is not
// drawing — the pane, the rail and the page composited above them all wait together — so this is the
// number every other motion number is downstream of.
//
// What was missing was where it goes. The frame gaps say the thread was busy; they do not say with
// what. So the paths this application owns are timed and the last cost of each is published, and
// whatever the sum does not account for is the engine's own render and paint.
//
// A reading costs two clock calls. Nothing here is conditional on a mode: an instrument that has to
// be turned on is one nobody has on when the defect happens.
import { useLayoutEffect } from "react";
import { moduleState } from "./moduleState";

/** The last cost of each named path, in milliseconds. */
const costs = moduleState("lib/mainThreadCost#costs", () => new Map<string, number>());

/** Runs the work and writes down what it cost. */
export function timed<T>(name: string, work: () => T): T {
  const started = performance.now();
  try {
    return work();
  } finally {
    costs.set(name, Math.round((performance.now() - started) * 100) / 100);
  }
}

/** What each timed path last cost. */
export function mainThreadCosts(): Record<string, number> {
  return Object.fromEntries([...costs.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * What a component's render and the commit that followed it cost.
 *
 * Called at the top of a render, it writes down the time from there to the layout effect that runs
 * after that commit — which is the whole subtree's render and commit, attributed to the component
 * that started it. A focus change that re-renders a workspace shows up here as the workspace's
 * number rather than as a frame gap with no name on it.
 */
export function useRenderCost(name: string): void {
  const started = performance.now();
  useLayoutEffect(() => {
    const done = performance.now();
    costs.set(name, Math.round((done - started) * 100) / 100);
    committedAtUnixMs = done;
  });
}

/** When the last timed render finished its commit. */
let committedAtUnixMs = 0;

/** How long ago the last timed render committed. What passes between that and the next frame is
 *  style, layout, paint and compositing — the engine's half, which no timer inside a component can
 *  reach. */
export function sinceCommitMs(now: number): number {
  return committedAtUnixMs === 0 ? -1 : Math.round(now - committedAtUnixMs);
}
