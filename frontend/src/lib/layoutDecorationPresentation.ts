import { useSyncExternalStore } from "react";
import { moduleState } from "./moduleState";

export type LayoutDecorationMotionReceipt = {
  status: "moving" | "settled";
  owner: "layout-rect-motion";
  generation: number;
  sequence: number;
  activeAnimations: number;
};

type ScopeState = {
  generation: number;
  sequence: number;
  activeAnimations: number;
  receipt: LayoutDecorationMotionReceipt;
  listeners: Set<() => void>;
};

const scopes = moduleState(
  "lib/layoutDecorationPresentation#scopes",
  () => new Map<string, ScopeState>(),
);

function stateOf(scope: string): ScopeState {
  const found = scopes.get(scope);
  if (found) return found;
  const created: ScopeState = {
    generation: 0,
    sequence: 0,
    activeAnimations: 0,
    receipt: {
      status: "settled",
      owner: "layout-rect-motion",
      generation: 0,
      sequence: 0,
      activeAnimations: 0,
    },
    listeners: new Set(),
  };
  scopes.set(scope, created);
  return created;
}

function publish(state: ScopeState): void {
  state.sequence += 1;
  state.receipt = {
    status: state.activeAnimations > 0 ? "moving" : "settled",
    owner: "layout-rect-motion",
    generation: state.generation,
    sequence: state.sequence,
    activeAnimations: state.activeAnimations,
  };
  for (const listener of state.listeners) listener();
}

/** One visual geometry animation owns one idempotent decoration-removal lease. */
export function beginLayoutDecorationMotion(scope: string): () => void {
  const state = stateOf(scope);
  if (state.activeAnimations === 0) state.generation += 1;
  state.activeAnimations += 1;
  publish(state);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    state.activeAnimations = Math.max(0, state.activeAnimations - 1);
    publish(state);
  };
}

export function layoutDecorationMotionReceipt(scope: string): LayoutDecorationMotionReceipt {
  return stateOf(scope).receipt;
}

/** Public surface: what each scope's motion lease holds right now.
 *
 * The presentation half of this module is gone. It answered which decorations were allowed while a
 * motion ran, and the answer is now the same for all of them — a frame, a boundary, an outline and a
 * rail all stay on the screen and travel with what they draw. Measured 2026-08-17: removing them left
 * every pane without its line for 148 to 372ms and 165 points of the window belonging to nobody, on
 * every one of the six ways focus can move in a three-pane window. What is left here is the lease
 * itself, which is the record that a layout motion is running.
 */
export function layoutDecorationMotionFacts(): Array<{
  scope: string;
  receipt: LayoutDecorationMotionReceipt;
}> {
  return [...scopes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, state]) => ({ scope, receipt: { ...state.receipt } }));
}

/** Whether a layout motion is running in this scope, as a React subscription.
 *
 * What reads it is the rule that a surface travels as its picture: a page composited above the
 * document covers whatever the document draws over it — a card, a rail crossing a pane, a region
 * taking its width — and the only way to show those is for the page to step aside while the layout
 * moves. The lease is already the record that a motion is running; this is that record, read. */
export function useLayoutMotionRunning(scope: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const state = stateOf(scope);
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => stateOf(scope).receipt.status === "moving",
    () => false,
  );
}
