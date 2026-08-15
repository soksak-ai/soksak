import { moduleState } from "./moduleState";
import { PRESENTATION_CLOCK, presentationNowUnixMs } from "./presentationClock";

export type LayoutSettlementEvent = Readonly<{
  key: string;
  phase: "invalidated" | "settled";
  revision: number;
  clock: typeof PRESENTATION_CLOCK;
  atUnixMs: number;
}>;

type Listener = (event: LayoutSettlementEvent) => void;

const state = moduleState("lib/layoutSettlement#state", () => ({
  requested: new Map<string, number>(),
  settled: new Map<string, number>(),
  listeners: new Set<Listener>(),
  events: [] as LayoutSettlementEvent[],
}));

const MAX_LAYOUT_SETTLEMENT_EVENTS = 64;

function emit(event: LayoutSettlementEvent): void {
  state.events.push(event);
  if (state.events.length > MAX_LAYOUT_SETTLEMENT_EVENTS) {
    state.events.splice(0, state.events.length - MAX_LAYOUT_SETTLEMENT_EVENTS);
  }
  for (const listener of state.listeners) listener(event);
}

/** Per-workspace revision published synchronously by any state mutation that changes layout. */
export function invalidateLayout(key: string): number {
  const revision = (state.requested.get(key) ?? 0) + 1;
  state.requested.set(key, revision);
  emit(Object.freeze({
    key, phase: "invalidated", revision,
    clock: PRESENTATION_CLOCK,
    atUnixMs: presentationNowUnixMs(),
  }));
  return revision;
}

/** Call only after the renderer adopted the latest solution and both prepare and move finished. */
export function requestedLayoutRevision(key: string): number {
  return state.requested.get(key) ?? 0;
}

/** The transaction owner closes only the exact revision it consumed. It never ACKs a later revision. */
export function settleLayout(key: string, revision: number): void {
  const requested = state.requested.get(key) ?? 0;
  if (!Number.isSafeInteger(revision) || revision <= 0 || revision > requested) {
    throw new Error(`layout settlement revision is not valid: ${key}/${revision}/${requested}`);
  }
  if ((state.settled.get(key) ?? 0) >= revision) return;
  state.settled.set(key, revision);
  emit(Object.freeze({
    key, phase: "settled", revision,
    clock: PRESENTATION_CLOCK,
    atUnixMs: presentationNowUnixMs(),
  }));
}

export function layoutSettlementFacts(key?: string): {
  active: boolean;
  pending: Array<{ key: string; requested: number; settled: number }>;
} {
  const pending = [...state.requested].flatMap(([candidate, requested]) => {
    if (key !== undefined && candidate !== key) return [];
    const settled = state.settled.get(candidate) ?? 0;
    return settled < requested ? [{ key: candidate, requested, settled }] : [];
  });
  return { active: pending.length > 0, pending };
}

/** Bounded ledger measuring acquisition between state publish and renderer ACK on one producer clock. */
export function layoutSettlementEvents(key?: string): LayoutSettlementEvent[] {
  return state.events
    .filter((event) => key === undefined || event.key === key)
    .map((event) => ({ ...event }));
}

export function onLayoutSettlement(listener: Listener): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function __resetLayoutSettlementForTest(): void {
  state.requested.clear();
  state.settled.clear();
  state.listeners.clear();
  state.events.splice(0);
}
