// Contract → implementer resolution wiring (L2 contract-pin C3). contractDiscovery (pure discovery) +
// contractSelection (user choice) + active plugin state combine into one "contract id → pluginId to open".
//
// [RULE] The core has no notion of what any contract means (C1) — a contract id is handled here as a string
// only, with no specific contract (terminal-spec and the like) and no specific implementer hardcoded.
// Discovery is implementer-agnostic (implementersOf), selection is a generic map (contractSelection).
//
// Discovery ignores status (implementersOf returns all), but a consumer opening a view targets enabled
// implementers only — a disabled plugin's view is never mounted (the consumer filters by status, the
// contract of pluginImplementers.test). sessions (newViewFor) and the settings UI consume this wiring.

import { usePlugins } from "../state/plugins";
import { useContractSelection } from "../state/contractSelection";
import {
  implementersOf,
  manifestImplements,
  type ImplementsNode,
} from "./contractDiscovery";
import type { ContractRequirement } from "./spec";

// Contract discovery nodes (manifest implements) of enabled plugins. Disabled and errored are excluded —
// only implementers whose view can be opened are candidates.
function activeImplementsNodes(): ImplementsNode[] {
  return Object.values(usePlugins.getState().plugins)
    .filter((p) => p.status === "enabled")
    .map((p) => ({ id: p.manifest.id, implements: manifestImplements(p.manifest) }));
}

// Contract id → list of enabled implementer pluginIds (node order preserved, exact match).
export function contractImplementers(contract: ContractRequirement): string[] {
  return implementersOf(contract, activeImplementsNodes());
}

// Contract id → the one implementer pluginId to open. The user selection when it is valid (a member of the
// enabled list), otherwise the first entry (no selection, stale selection, one implementer). null at zero
// implementers — the consumer degrades to an empty group.
export function resolveContractImplementer(contract: ContractRequirement): string | null {
  const impls = contractImplementers(contract);
  if (impls.length === 0) return null;
  const chosen = useContractSelection.getState().selected[contract.id];
  return chosen && impls.includes(chosen) ? chosen : impls[0];
}

// Contracts the selection UI shows — only those with two or more enabled implementers (with one there is nothing to choose). Ascending by contract id.
export function selectableContracts(): { contract: string; implementers: string[] }[] {
  const map = new Map<string, string[]>();
  for (const node of activeImplementsNodes()) {
    for (const provider of node.implements) {
      const implementers = map.get(provider.id) ?? [];
      if (!implementers.includes(node.id)) implementers.push(node.id);
      map.set(provider.id, implementers);
    }
  }
  return [...map.entries()]
    .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1)
    .map(([contract, implementers]) => ({ contract, implementers }))
    .filter(({ implementers }) => implementers.length >= 2);
}
