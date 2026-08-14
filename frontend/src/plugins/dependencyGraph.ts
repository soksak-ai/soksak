// Plugin↔plugin dependency graph resolution (pure functions, zero I/O). Consumed by the
// install/remove flows.
// General — ACP-independent (any library plugin ↔ dependent plugin). Zero lock-in. Idempotent
// (safe to re-run).
//
// Two directions:
//  - Install: co-install the target's uninstalled dependencies transitively (resolveMissingDeps plus
//    a fixpoint loop at the call site).
//  - Remove: cascade the dependents whose references would break (transitiveDependents) — proceeds
//    on consent, blocked without it.
// refcount/versionIssues audit graph integrity (every capability is exposed as a command).

import { semverSatisfies } from "./spec";

export interface DepNode {
  id: string;
  version: string;
  dependencies: Record<string, string>; // depId → semver range
}

// Direct dependents — plugins declaring id in their own dependencies (installed ones only).
export function directDependents(id: string, installed: DepNode[]): string[] {
  return installed.filter((n) => n.id !== id && id in (n.dependencies || {})).map((n) => n.id);
}

// Transitive dependents — every plugin whose reference breaks if id disappears. Return order = removal-safe order (farthest dependent first).
export function transitiveDependents(id: string, installed: DepNode[]): string[] {
  const order: string[] = []; // collected nearest → farthest
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const dep of directDependents(cur, installed)) {
        if (!seen.has(dep)) {
          seen.add(dep);
          order.push(dep);
          next.push(dep);
        }
      }
    }
    frontier = next;
  }
  // Removal is safe only from the far (leaf) dependents → reverse.
  return order.reverse();
}

// Activation levels — splits the target set into levels by dependency depth (the set generalization
// of activationChain).
// Members of one level are independent, so concurrent activation is safe, and the order between
// levels guarantees "dependencies first".
// The basis for parallelizing sequential activation of 46 units totalling 2.4s (measured) — a level
// is the safe boundary of concurrency.
// Dependencies outside the target set or not installed are ignored (owned by the install flow). A
// cycle groups everything left into the last level (guarantees progress).
export function activationLevels(ids: string[], installed: DepNode[]): string[][] {
  const byId = new Map(installed.map((n) => [n.id, n]));
  const target = new Set(ids);
  const placed = new Set<string>();
  const levels: string[][] = [];
  let remaining = ids.filter((id) => byId.has(id));
  while (remaining.length) {
    const level = remaining.filter((id) => {
      const deps = Object.keys(byId.get(id)?.dependencies || {});
      return deps.every((d) => !target.has(d) || placed.has(d));
    });
    if (level.length === 0) {
      levels.push(remaining); // cycle — the mutually blocked rest goes into one level (activation isolates each in its own try)
      break;
    }
    for (const id of level) placed.add(id);
    remaining = remaining.filter((id) => !placed.has(id));
    levels.push(level);
  }
  return levels;
}

// Reference count = number of direct dependents. 0 means a leaf (removable directly).
export function refcount(id: string, installed: DepNode[]): number {
  return directDependents(id, installed).length;
}

// Activation chain (topological sort along the dependency direction) — returns id and all of its
// transitive dependencies with the dependencies first (id last).
// Consenting and activating in this order always prepares the dependencies first (consumed by
// cascade consent/activation). A dependency can hold strong permissions (process and such), so the
// consent screen must show the whole chain (honest disclosure). A cycle is visited once (infinite
// loop guard).
// Uninstalled dependencies are skipped — the install flow (resolveMissingDeps) co-installs them separately.
export function activationChain(id: string, installed: DepNode[]): string[] {
  const byId = new Map(installed.map((n) => [n.id, n]));
  const out: string[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();
  const visit = (cur: string) => {
    if (done.has(cur) || onStack.has(cur)) return; // already visited, or a cycle — stop
    const node = byId.get(cur);
    if (!node) return; // uninstalled dependency (handled by the install flow)
    onStack.add(cur);
    for (const dep of Object.keys(node.dependencies || {})) visit(dep);
    onStack.delete(cur);
    done.add(cur);
    out.push(cur);
  };
  visit(id);
  return out;
}

// Removal cascade set — [dependents (farthest first) …, target]. Removing in this order always removes the dependents first.
export function cascadeRemovalSet(id: string, installed: DepNode[]): string[] {
  return [...transitiveDependents(id, installed), id];
}

export interface MissingDep {
  id: string;
  range: string;
}

// The target's uninstalled dependencies (direct only). The call site covers transitive installs by repeating clone→re-resolve (fixpoint).
export function resolveMissingDeps(
  targetDeps: Record<string, string>,
  installed: DepNode[],
): MissingDep[] {
  const have = new Set(installed.map((n) => n.id));
  return Object.entries(targetDeps || {})
    .filter(([id]) => !have.has(id))
    .map(([id, range]) => ({ id, range }));
}

// Uninstalled dependencies across the whole graph (union of every installed plugin's dependencies, ids deduped). Consumed by the transitive install loop.
export function allMissingDeps(installed: DepNode[]): MissingDep[] {
  const have = new Set(installed.map((n) => n.id));
  const seen = new Set<string>();
  const out: MissingDep[] = [];
  for (const n of installed) {
    for (const [id, range] of Object.entries(n.dependencies || {})) {
      if (!have.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push({ id, range });
      }
    }
  }
  return out;
}

export interface VersionIssue {
  id: string; // plugin that declared the dependency
  dep: string; // dependency target
  range: string; // required range
  have: string | null; // installed version (null = not installed)
  reason: "missing" | "unsatisfied" | "bad-range";
}

// Graph version integrity — whether each dependency is satisfied by the installed version. No issue when satisfied.
export function versionIssues(installed: DepNode[]): VersionIssue[] {
  const byId = new Map(installed.map((n) => [n.id, n]));
  const issues: VersionIssue[] = [];
  for (const n of installed) {
    for (const [dep, range] of Object.entries(n.dependencies || {})) {
      const have = byId.get(dep)?.version ?? null;
      if (have == null) {
        issues.push({ id: n.id, dep, range, have: null, reason: "missing" });
        continue;
      }
      const sat = semverSatisfies(have, range);
      if (sat === null) issues.push({ id: n.id, dep, range, have, reason: "bad-range" });
      else if (!sat) issues.push({ id: n.id, dep, range, have, reason: "unsatisfied" });
    }
  }
  return issues;
}

// Graph summary — one plugin's dependencies, dependents and reference count (returned by the plugin.deps command).
export interface DepSummary {
  id: string;
  version: string;
  dependencies: Record<string, string>;
  dependents: string[]; // direct dependents
  refcount: number;
  cascadeOnRemove: string[]; // transitive dependents removed along with this plugin
}

export function depSummary(id: string, installed: DepNode[]): DepSummary | null {
  const node = installed.find((n) => n.id === id);
  if (!node) return null;
  return {
    id,
    version: node.version,
    dependencies: node.dependencies || {},
    dependents: directDependents(id, installed),
    refcount: refcount(id, installed),
    cascadeOnRemove: transitiveDependents(id, installed),
  };
}
