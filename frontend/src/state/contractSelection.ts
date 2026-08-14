import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// Contract resolution settings — a generic "contract id → selected implementation pluginId" map
// (contract-agnostic). Persisted to localStorage plus the app.data authority.
//
// [RULE] The core does not interpret any contract's meaning (C1). This store is a pure selection
// store keyed by contract id — no specific contract such as terminal-spec, no specific
// implementation. Implementation discovery is contractDiscovery (implementersOf); the wiring and
// fallback between selection and discovery are owned by contractResolve. This file only stores.
//
// A selection is valid only as an element of the discovered implementation list — a stale selection
// absent from the list is ignored by the consumer (contractResolve), which falls back to the first
// entry. This store enforces no validity.

export type ContractSelectionMap = Record<string, string>;

interface ContractSelectionState {
  selected: ContractSelectionMap; // contract id → implementation pluginId
  // Select the implementation for a contract (re-selecting the same contract overwrites).
  select: (contract: string, pluginId: string) => void;
  // Remove the selection — the consumer falls back to the first entry (back to default).
  clear: (contract: string) => void;
}

const DEFAULTS: { selected: ContractSelectionMap } = { selected: {} };
const KEY = "soksak.contractSelection";

type PersistedContractSelection = typeof DEFAULTS;

function serialize(s: ContractSelectionState): PersistedContractSelection {
  return { selected: s.selected };
}

const contractSelectionSync = createCoreSync<PersistedContractSelection>({
  key: "contractSelection",
  lsKey: KEY,
  fallback: DEFAULTS,
  apply: (v) => useContractSelection.setState({ selected: v.selected ?? {} }),
});
export const initContractSelectionPersistence = (deps: CoreStoreDeps): (() => void) =>
  contractSelectionSync.init(deps);

function load(): PersistedContractSelection {
  return { ...DEFAULTS, ...contractSelectionSync.loadSync() };
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the side that filled them treats them as already
// filled and never refills (empty forever).
export const useContractSelection = moduleState("state/contractSelection#store", () =>
  create<ContractSelectionState>((set, get) => {
  const save = () => {
    contractSelectionSync.save(serialize(get()));
  };
  return {
    ...load(),
    select: (contract, pluginId) => {
      set({ selected: { ...get().selected, [contract]: pluginId } });
      save();
    },
    clear: (contract) => {
      const next = { ...get().selected };
      delete next[contract];
      set({ selected: next });
      save();
    },
  };
}),
);
