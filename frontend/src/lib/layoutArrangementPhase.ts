import { moduleState } from "./moduleState";

export type LayoutArrangementIdentity = Readonly<{
  key: string;
  station: number | null;
  focusId: string | null;
}>;

export type LayoutArrangementPhaseFact = Readonly<{
  ownerKey: string;
  current: LayoutArrangementIdentity;
  displayed: LayoutArrangementIdentity;
  phase: "idle" | "preparing" | "starting" | "traveling" | "blocked";
  preparationTargetKey: string | null;
  lastFailure: Readonly<{ targetKey: string; message: string }> | null;
}>;

const state = moduleState("lib/layoutArrangementPhase#state", () => ({
  facts: new Map<string, LayoutArrangementPhaseFact>(),
}));

/** Current fact the WorkspacePlane phase publishes to the observation surface. One latest entry per owner. */
export function publishLayoutArrangementPhase(fact: LayoutArrangementPhaseFact): void {
  state.facts.set(fact.ownerKey, structuredClone(fact));
}

export function removeLayoutArrangementPhase(ownerKey: string): void {
  state.facts.delete(ownerKey);
}

export function layoutArrangementPhaseFacts(): LayoutArrangementPhaseFact[] {
  return [...state.facts.values()]
    .sort((a, b) => a.ownerKey.localeCompare(b.ownerKey))
    .map((fact) => structuredClone(fact));
}

export function __resetLayoutArrangementPhasesForTest(): void {
  state.facts.clear();
}
