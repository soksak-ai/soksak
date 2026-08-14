// The single seam targeted by the core's terminal affordances (⌘T, layout.apply dev, visible
// execution of install commands).
//
// The core references no terminal engine (implementation) — it references the terminal contract
// (interface) only, and which engine to open is picked by the user setting (contractSelection)
// (R7: bind to the public interface, not to an implementation). A new engine is admitted by an
// implements declaration in its manifest alone — the core is not edited.
//
// [RULE] Never hardcode a specific plugin id or program id. The only name referenced here is the
// contract id (TERMINAL_CONTRACT) — the name of the capability the "open a terminal" affordance
// targets. The generic machinery for contract discovery, selection and resolution
// (contractDiscovery/contractResolve/contractSelection) stays contract-agnostic (C1) — this file is
// a consumer of that machinery, not a redefinition.

import { resolveContractImplementer } from "./contractResolve";
import { listPrograms } from "./programRegistry";
import type { ContractRequirement } from "./spec";

// The contract id targeted by the core's terminal affordances, and the exact first-party baseline (NAMING §8).
export const TERMINAL_CONTRACT: ContractRequirement = Object.freeze({
  id: "soksak-spec-plugin-terminal",
  range: "0.0.1",
});

// Resolves the program id of the configured terminal engine — addViewToGroup/split/layout open a view by program id.
// contract → implementer pluginId (setting, discovery) → the program id that implementer opens as its own view.
// null when no implementer is active — consumers degrade to blank/skip (no hardcoded fallback).
export function resolveTerminalProgram(): string | null {
  const impl = resolveContractImplementer(TERMINAL_CONTRACT);
  if (impl === null) return null;
  // Only a program the implementer opens as its own plugin view (its own view program, not the
  // cross-plugin viewPlugin or the contract viewContract) is a candidate — pick the terminal engine's own view program.
  const prog = listPrograms().find(
    (p) =>
      p.pluginId === impl &&
      p.decl.viewPlugin === undefined &&
      p.decl.viewContract === undefined,
  );
  return prog?.decl.id ?? null;
}
