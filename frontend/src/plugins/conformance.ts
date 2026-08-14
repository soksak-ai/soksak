// conformance — declared ≡ actual consistency of plugin contributions (integrated).
// v1 law: the manifest declaration (declared) and the runtime wiring (actual) match (both directions).
//  - gateContribution: rejects undeclared-actual (folds the 4 find+throw sites in api.ts into one).
//  - missingRegistrations: detects declared-but-not-actual (inventory after activate).
// Pure logic with no app/DOM dependency — subject to vitest unit verification.

// Single truth for contract id grammar = spec package contracts.ts (the same regex the schema gate reads).
// Single truth for the C2 static judgment = spec package transparency.ts (the same functions the gate and the validate CLI read).
import {
  C2_STATIC_ENFORCEMENT,
  parseContractProviderRef,
  type ContractProviderRef,
  type EnforcementMode,
  type StaticTransparencyRule,
} from "./spec";
export { C2_STATIC_ENFORCEMENT, isContentView, transparencyViolations } from "./spec";
export type { EnforcementMode, StaticTransparencyRule } from "./spec";

// Finds and returns the declared entry matching id. Fatal throw when absent.
// The message names contributes.<contributesKey>, the <noun>, and the <id> — see the throw below.
export function gateContribution<T>(opts: {
  contributesKey: string; // "commands" | "views" | "fileViewers" | "iconSets" ...
  noun: string; // Localized noun ("command"/"view"/"file viewer"/"set") — for the error message
  id: string;
  declared: readonly T[];
  idOf: (entry: T) => string; // commands=name, everything else=id
}): T {
  const found = opts.declared.find((e) => opts.idOf(e) === opts.id);
  if (!found) {
    throw new Error(
      tmsg("plugin.contrib.undeclared", {
        key: opts.contributesKey,
        noun: opts.noun,
        id: opts.id,
      }),
    );
  }
  return found;
}

// List of ids declared but not registered (declaration order preserved). Detects declared-but-not-actual.
// Registered without a declaration is not handled here (that is gateContribution's half — the two directions are split).
export function missingRegistrations(
  declaredIds: readonly string[],
  registeredIds: readonly string[],
): string[] {
  const reg = new Set(registeredIds);
  return declaredIds.filter((id) => !reg.has(id));
}

// ── Composite law C2 — three transparency surfaces (command, status, DOM) ────────────────────
// Every feature must expose three surfaces. The single truth for the static judgments (manifest-only:
// command-surface, view-nodes, content-view-status) and their enforcement table (C2_STATIC_ENFORCEMENT)
// is the spec package transparency.ts — loader, installed-bundle gate, and validate CLI all consume the
// same functions and table (no mirrors).
// What remains here is the judgment that needs runtime evidence (viewStatusConformance) and the full
// enforcement table composed with the runtime rule (C2_ENFORCEMENT).
// Re-legislation history (the spec package transparency.ts continues the history of the static rules):
//   2026-07-11 introduced — violations remained, so all three started at warn (41 dev-home manifests measured):
//     command-surface 5 · view-nodes 6 · view-status 4/10.
//   2026-07-11 promoted — after the two static rules reached 0 violations (11-plugin conformance sweep),
//     command-surface and view-nodes were promoted to blocking. Machine condition = c2-transparency-scan
//     headless gate exit 0 (wired into make gates).
//   2026-07-11 moved — static judgments and the enforcement table moved to the spec package (one judgment —
//     the gate mirror was dropped), a manifest declaration (contributes.views[].status) was added on the
//     status axis, and its absence is judged as content-view-status (starts at warn — ratchet).
// The only violation of view-status (the runtime rule) is a code report outside the declaration
// (undeclared). A null in an instantaneous observation is not a violation — the original design semantics
// of the status axis is null = nothing to report (normal), transient codes (connecting and the like) can be
// faster than the observation window so an instantaneous-unreported rule is unmeasurable in principle, and
// forcing a normal-state code puts badge noise on every tab (perfection principle). unreported stays as
// diagnostic information only.
// Re-legislation history (view-status): 2026-07-11 started at warn → 2026-07-11 the instantaneous-unreported
// rule was repealed (correction of an error in the criterion itself — grounds above) plus live measurement
// (debug isolation, 2 content views mounted) confirmed undeclared=0, then promoted to blocking. Enforcement
// and measurement points are plugin.conformance (runtime diagnostics) and the publish gate (doctor).

// Full rule axis = 3 static rules (spec package) + 1 runtime rule (view-status — owned by the core).
export type TransparencyRule = StaticTransparencyRule | "view-status";
// Enforcement mode — the axis C2 and C3 share (blocking = refuse activation, warn = warning). TransparencyMode is kept for name compatibility.
export type TransparencyMode = EnforcementMode;

// Full enforcement table — static rule modes are inherited from the spec package table (single truth) and
// only the runtime rule is added.
// A change to this table is a re-legislation commit, and the pin test in conformance.test.ts forces a companion revision.
export const C2_ENFORCEMENT: Readonly<Record<TransparencyRule, TransparencyMode>> = {
  ...C2_STATIC_ENFORCEMENT,
  "view-status": "blocking",
};

export interface TransparencyViolation {
  rule: TransparencyRule;
  detail: string; // Statement of the violation (what, and how many) — placed into the warning or refusal message as is
}

// ② The view-status judgment — runtime input, declared ≡ reported. The capability exists in the core
// (viewRegistry PluginViewContext.setStatus → sessions view.status → status.query). At activation time the
// view is not mounted yet, so the loader cannot judge — the enforcement points are the runtime diagnostic
// (plugin.conformance) and the publish gate (doctor).
// Only the pure judgment is here (no plugin id enters — it takes the declared array and the observed array only).
// Declaration = contributes.views[].status (list of reported codes, [] = explicitly stateless, undefined = no declaration).
// Two judgment directions (each enforced on a different rule axis):
//   unreported: declaration present (non-empty) and nothing reported → view-status violation (promise unmet).
//   undeclared: reported code absent from the declaration (missing, [], or outside the list) → content-view-status
//               missing-declaration warning (the static judgment sees only a missing declaration; a missing code
//               surfaces only through runtime measurement).
// No declaration + nothing reported is silent here — that fact is itself a static content-view-status violation (no double reporting).
export interface ViewStatusObservation {
  viewId: string; // Mount instance id
  view: string; // Declared view id (contributes.views[].id)
  code: string | null; // Reported status code, null = nothing reported
}

export interface ViewStatusJudgment {
  unreported: string[]; // Declared and not reported — the view-status violation set (mount order preserved)
  undeclared: { viewId: string; view: string; code: string }[]; // Reported outside the declaration — missing-declaration warning
}

export function viewStatusConformance(
  declaredViews: readonly { id: string; status?: readonly string[] }[],
  observed: readonly ViewStatusObservation[],
): ViewStatusJudgment {
  const declByView = new Map(declaredViews.map((v) => [v.id, v.status]));
  const unreported: string[] = [];
  const undeclared: ViewStatusJudgment["undeclared"] = [];
  for (const o of observed) {
    const decl = declByView.get(o.view);
    if (o.code === null) {
      if (decl !== undefined && decl.length > 0) unreported.push(o.viewId);
    } else if (decl === undefined || !decl.includes(o.code)) {
      undeclared.push({ viewId: o.viewId, view: o.view, code: o.code });
    }
  }
  return { unreported, undeclared };
}

// Classifies violations by enforcement mode — blocking violations are refusal targets, warn violations are warning targets. Shared by C2 and C3 (single truth).
export function partitionEnforcement<R extends string, V extends { rule: R }>(
  violations: readonly V[],
  enforcement: Readonly<Record<R, EnforcementMode>>,
): { blocking: V[]; warn: V[] } {
  const blocking: V[] = [];
  const warn: V[] = [];
  for (const v of violations) {
    (enforcement[v.rule] === "blocking" ? blocking : warn).push(v);
  }
  return { blocking, warn };
}

export function partitionTransparency(
  violations: readonly TransparencyViolation[],
  enforcement: Readonly<Record<TransparencyRule, TransparencyMode>> = C2_ENFORCEMENT,
): { blocking: TransparencyViolation[]; warn: TransparencyViolation[] } {
  return partitionEnforcement(violations, enforcement);
}

// ── Composite law C3 — L2 contract pin: generic check of the implements declaration ────────────
// The manifest implements: [{ id: "soksak-spec-<kind>-<domain>", version }] is this plugin's declaration of
// the contracts it implements, and consumers discover implementations by contract id (contractDiscovery —
// implementation-agnostic). Defining and verifying the surfaces a contract requires (which command/view must
// exist) is the contract owner's (the plugin's) job — the core has no information about any contract (C1), so
// it checks only that the declaration itself is well formed, generically: shape, grammar (NAMING §8), duplicates.
// Re-legislation history: 2026-07-11 started at warn (new axis) → 2026-07-11 promoted to blocking — after the
// schema landing (P0.5), 0 violations measured on installed bundles (0 plugins declare implements, and L2 is
// opt-in, so no declaration is legal).
// Later relaxation or re-promotion happens only through an explicit re-legislation commit (C4, C5). The pin test forces a companion revision.

export type ImplementsRule =
  | "implements-shape"
  | "implements-grammar"
  | "implements-duplicate";

export const C3_ENFORCEMENT: Readonly<Record<ImplementsRule, EnforcementMode>> = {
  "implements-shape": "blocking",
  "implements-grammar": "blocking",
  "implements-duplicate": "blocking",
};

export interface ImplementsViolation {
  rule: ImplementsRule;
  detail: string; // Statement of the violation — placed into the warning or refusal message as is
}

// implements raw value (rawImplements) → violation list. undefined = no declaration (legal — L2 is opt-in).
// Non-string entries are reported as a shape violation while the grammar and duplicate checks continue on the string entries (0 concealment).
export function implementsViolations(raw: unknown): ImplementsViolation[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    return [{ rule: "implements-shape", detail: `implements is not an array (${typeof raw})` }];
  }
  const out: ImplementsViolation[] = [];
  const nonObjects = raw.filter((value) => typeof value !== "object" || value === null || Array.isArray(value));
  if (nonObjects.length > 0) {
    out.push({
      rule: "implements-shape",
      detail: `non-object entries ${nonObjects.length} — implements requires { id, version } providers`,
    });
  }
  const entries = raw.filter((value): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value));
  const providers: ContractProviderRef[] = [];
  const invalid: number[] = [];
  entries.forEach((entry, index) => {
    const errors: string[] = [];
    const parsed = parseContractProviderRef(entry, `implements[${index}]`, errors);
    if (parsed) providers.push(parsed);
    else invalid.push(index);
  });
  if (invalid.length > 0) {
    out.push({
      rule: "implements-grammar",
      detail: `invalid { id, version } provider entries: ${invalid.join(", ")}`,
    });
  }
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) dup.add(provider.id);
    seen.add(provider.id);
  }
  if (dup.size > 0) {
    out.push({ rule: "implements-duplicate", detail: `duplicate declarations: ${[...dup].join(", ")}` });
  }
  return out;
}

// declared ≡ actual diagnostic for nodes. actual = data-node in the DOM (nodePath from scanNodes).
// Dynamic list nodes have the form "id/key", so they match on the base id (first segment). nodes is a
// contribution with no register API, so this emits a diagnostic instead of a gate (throw):
//   missing = declared but not wired in the DOM (declared→actual), orphan = in the DOM but not declared (actual→declared).
export function nodeConformance(
  declaredIds: readonly string[],
  scannedNodePaths: readonly string[],
): { missing: string[]; orphan: string[] } {
  const declared = new Set(declaredIds);
  const scannedBase = new Set(scannedNodePaths.map((p) => p.split("/")[0]));
  return {
    missing: declaredIds.filter((id) => !scannedBase.has(id)),
    orphan: [...scannedBase].filter((id) => !declared.has(id)),
  };
}

// ── Single truth of unit selection — did the bundle harden the unit name (publish boundary) ────────
// Which engine unit to spawn is decided by the manifest sidecars[]. Hardening "sidecar:<name>" into the
// bundle as a constant makes declared ≠ actual the moment the manifest alone changes. The runtime spawn
// gate catches that mismatch loudly (app.process.spawn), but only on execution — catch it statically
// before publishing too.
//
// Even a declared name is a violation when it is baked in as a literal: the moment the manifest changes,
// that literal becomes false, and the only sign is the app dying. The name comes from
// app.process.sidecarName (the contract).

export interface SidecarSpawnViolation {
  /** Unit name hardened into the bundle. */
  unit: string;
  /** Whether the manifest declares that name (a literal is a violation even when declared — see the comment above). */
  declared: boolean;
}

/** Finds `sidecar:<name>` literals in the bundle source. Even one means unit selection is in the bundle
 *  instead of the manifest. */
export function sidecarSpawnViolations(
  bundle: string,
  declared: ReadonlyArray<{ name: string }>,
): SidecarSpawnViolation[] {
  const names = new Set(declared.map((d) => d.name));
  const out: SidecarSpawnViolation[] = [];
  const seen = new Set<string>();
  for (const m of bundle.matchAll(/["'`]sidecar:([a-z0-9][a-z0-9-]*)["'`]/g)) {
    const unit = m[1];
    if (seen.has(unit)) continue;
    seen.add(unit);
    out.push({ unit, declared: names.has(unit) });
  }
  return out;
}

// ── Do the called names actually resolve ────────────────────────────────────────────
// Nobody checked the names a plugin calls through `app.commands.execute("<name>")`. So when the core
// renames or evicts a command, the plugin calling that name dies silently — a dead call leaves neither
// exception nor log, and if nobody uses that feature it stays hidden for many rounds (measured: when the
// browser was evicted into a plugin, `browser.eval` and `browser.open` disappeared, and the features of
// the three plugins calling them were left dead). This is the other half of declared ≡ actual: check not
// only what is registered but **what is called**.
export interface CommandCallScan {
  /** Command names written as literals (deduplicated). */
  literals: string[];
  /** Count of calls built by string assembly — not statically judgable, so only counted (no silent concealment). */
  dynamic: number;
}

/** Walks the command names passed to execute in the bundle source. Bundlers preserve property names, so
 *  `.commands.execute(` survives even in a minified bundle. Template interpolation (${…}) is not a literal. */
export function executedCommandNames(bundle: string): CommandCallScan {
  const literals = new Set<string>();
  let dynamic = 0;
  const re = /\.commands\s*\.\s*execute\s*\(\s*(?:(["'])([^"'\n]+)\1|`([^`]*)`)/g;
  for (const m of bundle.matchAll(re)) {
    const quoted = m[2];
    const template = m[3];
    // A name built by joining fragments cannot be resolved statically — counting the first fragment as the
    // name accuses a healthy call of being dead (measured: the PREFIX of `execute(PREFIX + name)` was
    // flagged unresolved).
    const after = bundle.slice((m.index ?? 0) + m[0].length).trimStart();
    if (after.startsWith("+")) {
      dynamic += 1;
      continue;
    }
    if (quoted !== undefined) {
      literals.add(quoted);
      continue;
    }
    if (template !== undefined) {
      if (template.includes("${")) dynamic += 1;
      else literals.add(template);
    }
  }
  return { literals: [...literals].sort(), dynamic };
}

/** An unresolved call = a name absent from the core catalog and from every installed plugin's declaration.
 *  The declaration remains even when the target is disabled, so only "a name that exists nowhere" is caught here. */
export function unresolvedCommandCalls(
  literals: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  return literals.filter((n) => !known.has(n));
}
