import { useSyncExternalStore } from "react";
import { moduleState } from "./moduleState";

export type LayoutDecorationMotionReceipt = {
  status: "moving" | "settled";
  owner: "layout-rect-motion";
  generation: number;
  sequence: number;
  activeAnimations: number;
};

export type LayoutDecorationPresentation = {
  structuralFrames: "present" | "absent";
  focusBoundary: "present" | "absent";
  relationOverlay: "present" | "absent";
  railSurface: "present" | "absent";
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

/** Public composition verdict surface. Returns the per-scope transaction-owned lifetime together with the decoration set allowed during it. */
export function layoutDecorationPresentationFacts(): Array<{
  scope: string;
  receipt: LayoutDecorationMotionReceipt;
  presentation: LayoutDecorationPresentation;
}> {
  return [...scopes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, state]) => ({
      scope,
      receipt: { ...state.receipt },
      presentation: layoutDecorationPresentation(state.receipt),
    }));
}

export function layoutDecorationPresentation(
  receipt: LayoutDecorationMotionReceipt,
): LayoutDecorationPresentation {
  const value = receipt.status === "settled" ? "present" : "absent";
  return {
    structuralFrames: value,
    focusBoundary: value,
    // The relation outline is a destination marker, not a motion decoration. The click commit
    // swaps it to a new identity pinned at the destination, so it does not wait for rect
    // animation settlement.
    relationOverlay: "present",
    railSurface: value,
  };
}

export function useLayoutDecorationPresentation(scope: string): LayoutDecorationPresentation {
  const receipt = useSyncExternalStore(
    (listener) => {
      const state = stateOf(scope);
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => stateOf(scope).receipt,
    () => stateOf(scope).receipt,
  );
  return layoutDecorationPresentation(receipt);
}

export function __resetLayoutDecorationPresentationForTest(): void {
  scopes.clear();
}
