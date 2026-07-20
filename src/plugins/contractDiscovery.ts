// Generic domain-contract discovery. Providers publish exact `{id, version}` evidence;
// consumers query `{id, range}`. Matching by a concatenated `name@version` string is not
// an API and is intentionally impossible here.
import {
  contractProviderKey,
  contractRequirementSatisfiedBy,
  parseContractProviderRef,
  type ContractProviderRef,
  type ContractRequirement,
  type PluginManifest,
} from "./spec";

export interface ImplementsNode {
  id: string;
  implements: ContractProviderRef[];
}

export function implementersOf(
  requirement: ContractRequirement,
  nodes: ImplementsNode[],
): string[] {
  return nodes
    .filter((node) => node.implements.some((provider) =>
      contractRequirementSatisfiedBy(requirement, provider)))
    .map((node) => node.id);
}

// Identity discovery — every node whose implements carries this contract id, any version.
// Version compatibility is enforced at the call boundary by manifest declaration, so
// discovery by id alone deliberately skips range matching.
export function implementersOfId(id: string, nodes: ImplementsNode[]): string[] {
  return nodes
    .filter((node) => node.implements.some((provider) => provider.id === id))
    .map((node) => node.id);
}

export function contractsOf(pluginId: string, nodes: ImplementsNode[]): ContractProviderRef[] {
  const node = nodes.find((candidate) => candidate.id === pluginId);
  if (!node) return [];
  const seen = new Set<string>();
  return node.implements.filter((provider) => {
    const key = contractProviderKey(provider);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function allContracts(
  nodes: ImplementsNode[],
): { contract: ContractProviderRef; implementers: string[] }[] {
  const map = new Map<string, { contract: ContractProviderRef; implementers: string[] }>();
  for (const node of nodes) {
    const seenInNode = new Set<string>();
    for (const provider of node.implements) {
      const key = contractProviderKey(provider);
      if (seenInNode.has(key)) continue;
      seenInNode.add(key);
      const existing = map.get(key) ?? { contract: provider, implementers: [] };
      existing.implementers.push(node.id);
      map.set(key, existing);
    }
  }
  return [...map.entries()]
    .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1)
    .map(([, value]) => value);
}

export function rawImplements(manifest: PluginManifest): unknown {
  return manifest.implements;
}

export function manifestImplements(manifest: PluginManifest): ContractProviderRef[] {
  const raw = rawImplements(manifest);
  if (!Array.isArray(raw)) return [];
  const out: ContractProviderRef[] = [];
  for (const item of raw) {
    const errors: string[] = [];
    const provider = parseContractProviderRef(item, "implements", errors);
    if (provider) out.push(provider);
  }
  return out;
}
