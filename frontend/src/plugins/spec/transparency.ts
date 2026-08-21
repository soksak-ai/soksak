// C2 static transparency judgment — the manifest-only rules of composition law C2 (three
// transparencies: command·status·DOM).
// This file owns the judgment (pure functions — manifest data in, no runtime
// evidence). Enforcement is the consumer boundary's job: the core loader (activation refusal or
// warning), plugin.conformance (diagnostics), scripts/gates/c2-transparency-scan.mjs (installed-unit
// gate) and bin/validate.mjs (author gate) all import this judgment — do not mirror it (no second
// truth).
//
// Three static rules:
//   ① command-surface     has capability (views/programs/overlays) ∧ commands=0 → violation
//   ② view-nodes          render surface (views/overlays)>0 ∧ nodes=0 → violation (no ui.tree)
//      The view-nodes rule covers view and overlay DOM together.
//   ③ content-view-status a content view with no status declaration → violation (a stateless view
//                         states [] — silence is not allowed)
// The runtime rule (does a mounted view actually report the codes it declared — view-status,
// declared≡reported) cannot be judged from the manifest and stays in the core
// (src/plugins/conformance.ts viewStatusConformance) — this file holds only what needs no runtime evidence.

export type EnforcementMode = "blocking" | "warn";

export type StaticTransparencyRule =
  | "command-surface"
  | "view-nodes"
  | "content-view-status";

export interface TransparencyViolation {
  rule: StaticTransparencyRule;
  detail: string; // statement of the violation (what, and how many) — used verbatim in the warning or refusal message
}

// Static rule enforcement table — loader, gates and CLI use this one table. All three rules are
// blocking, and changing that requires a versioned contract change plus conformance covering the
// same deployed population.
export const C2_STATIC_ENFORCEMENT: Readonly<
  Record<StaticTransparencyRule, EnforcementMode>
> = {
  "command-surface": "blocking",
  "view-nodes": "blocking",
  "content-view-status": "blocking",
};

// Judgment input — a structural subset of the parsed manifest contributes.
// PluginManifest["contributes"] assigns directly (structural typing). It takes the real declaration
// arrays, not counts — rule ③ needs per-view surfaces·status (no degradation to aggregates).
export interface TransparencyView {
  id: string;
  surfaces: readonly string[];
  status?: readonly string[];
}

export interface TransparencyContributes {
  views: readonly TransparencyView[];
  overlays: readonly unknown[];
  commands: readonly unknown[];
  programs: readonly unknown[];
  nodes: readonly unknown[];
}

// A content view is one drawn on a tab. Measured across 40 installed manifests: content views are
// identified by this axis alone, with no separate marker — 9 tab-only, 1 declaring both, and that
// one still rides in a content tab. setStatus is valid on a tab and a no-op beside the work, so the
// scope of the status declaration duty matches this test.
export function isContentView(view: { surfaces: readonly string[] }): boolean {
  return view.surfaces.includes("tab");
}

// The capability predicate counts every render/program contribution axis. An overlay also renders
// DOM in a separate sandbox document, so it must expose the command control surface and the nodes
// address surface exactly as a view does.
export function transparencyViolations(
  c: TransparencyContributes,
): TransparencyViolation[] {
  const out: TransparencyViolation[] = [];
  if (
    (c.views.length > 0 || c.programs.length > 0 || c.overlays.length > 0) &&
    c.commands.length === 0
  ) {
    out.push({
      rule: "command-surface",
      detail: `capability declared (views=${c.views.length}, programs=${c.programs.length}, overlays=${c.overlays.length}) but commands=0`,
    });
  }
  if ((c.views.length > 0 || c.overlays.length > 0) && c.nodes.length === 0) {
    out.push({
      rule: "view-nodes",
      detail: `render surface (views=${c.views.length}, overlays=${c.overlays.length}) but contributes.nodes=0 — nothing exposed in ui.tree`,
    });
  }
  const undeclared = c.views.filter((v) => isContentView(v) && v.status === undefined);
  if (undeclared.length > 0) {
    out.push({
      rule: "content-view-status",
      detail: `${undeclared.length} content view(s) declare no status: ${undeclared
        .map((v) => v.id)
        .join(", ")} — list the reported status codes ([] when stateless) in contributes.views[].status`,
    });
  }
  return out;
}
