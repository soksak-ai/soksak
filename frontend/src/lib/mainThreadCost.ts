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

/** What each named path has cost in total, in milliseconds, since this window started.
 *
 * A total, not the last value. The last value cannot be attributed to a stretch: read across a
 * window that stopped drawing for 45ms, every path showed the same number before, during and after
 * it, and one of them — a plugin view's mount, 32ms — was read here as the cause of the stall when
 * it had happened while the window was being built. Totals subtract: what a stretch cost is the
 * difference between its ends, and a path that did not run over it differences to zero. */
const costs = moduleState("lib/mainThreadCost#costs", () => new Map<string, number>());

/** Adds one reading to a path's total. */
function add(name: string, ms: number): void {
  costs.set(name, Math.round(((costs.get(name) ?? 0) + ms) * 100) / 100);
}

/** Runs the work and writes down what it cost. */
export function timed<T>(name: string, work: () => T): T {
  const started = performance.now();
  try {
    return work();
  } finally {
    add(name, performance.now() - started);
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
    add(name, done - started);
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

/**
 * What the engine spends on style and layout for the commit that just happened.
 *
 * The costs above are this application's own paths, and on a window that stopped drawing for 55ms
 * they came to 5. The rest is the engine's half — style, layout, paint, compositing — and no timer
 * inside a component can reach it: the thread is inside the engine, so the frame clock and the timer
 * that would have measured the gap are both waiting with everything else.
 *
 * Reading a box forces style and layout to finish before the answer can be given, so calling it
 * right after a commit and timing the call attributes that half. What is left over — the gap the
 * frames still show minus this — is paint and compositing, which nothing in a document can time.
 *
 * The layout it forces is one the next frame would have done anyway. It is moved earlier, not added.
 */
export function useEngineLayoutCost(): void {
  useLayoutEffect(() => {
    timed("engine.layout", () => document.documentElement.getBoundingClientRect().height);
  });
}

/**
 * The same for work that is awaited.
 *
 * A round trip is not main-thread time by itself — but what comes back over it is handed to this
 * thread to parse, and a picture arrives as a data URL half a megabyte long. Timing the await gives
 * how long the answer took to become usable, which is the half a caller can do something about.
 */
export async function timedAwait<T>(name: string, work: Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work;
  } finally {
    add(name, performance.now() - started);
  }
}
