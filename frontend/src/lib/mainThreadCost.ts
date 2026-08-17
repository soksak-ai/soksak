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
