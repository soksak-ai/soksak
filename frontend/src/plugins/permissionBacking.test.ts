// Permission backing invariant — every declared PluginPermission must have a real enforcement point.
// When a core feature moves out to a plugin(e.g. editor extraction → app.editor removed) that permission becomes
// a "dead permission", which the existing tests did not catch. This test catches the mismatch mechanically as RED,
// in both directions:
//   (A) Dead permission: in PERMISSIONS but at no enforcement point → must be removed.
//   (B) Undeclared permission: gated by api.ts but absent from PERMISSIONS → must be added.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, type PluginPermission } from "./spec";

const apiSrc = readFileSync(join(process.cwd(), "src", "plugins", "api.ts"), "utf8");

// Permissions with which api.ts gates a real app.* surface — extracted from has("perm") calls(the single evidence of runtime capability).
function apiGatedPermissions(): Set<string> {
  const set = new Set<string>();
  for (const m of apiSrc.matchAll(/has\("([a-z:]+)"\)/g)) set.add(m[1]);
  return set;
}

// Permissions that are legitimate without an api.ts has() gate(enforcement point is not api.ts):
//   - programs: the loader auto-registers contributes.programs declaratively(no imperative api.ts surface §2.6)
//   - commands:destructive / commands:inject: executeGated maps them from the command danger grade(not has)
//   - service: enforcement points are the manifest verdict(parseManifest validateServiceRules — a service
//     declaration requires the permission) and the core bind gate. It opens no new app.* surface in plugin
//     JS(PS2 — a service has 0 surfaces of its own, command ownership is core routing). Norm docs/PLUGIN-SERVICE.md.
// An entry in this allowlist needs a stated reason for "why there is no api.ts gate"(no arbitrary additions).
const NON_API_GATED: ReadonlySet<PluginPermission> = new Set([
  "programs",
  "commands:destructive",
  "commands:inject",
  "service",
]);

describe("permission backing invariant — no dead permission after the core-to-plugin extraction", () => {
  it("(A) every declared permission is gated by an api.ts surface or explicitly declared — zero dead permissions", () => {
    const gated = apiGatedPermissions();
    const dead = PERMISSIONS.filter((p) => !gated.has(p) && !NON_API_GATED.has(p));
    expect(dead).toEqual([]); // non-empty is RED: a dead permission with no backing (for example "editor" after app.editor was removed)
  });

  it("(B) every permission api.ts gates is declared in PERMISSIONS — zero undeclared", () => {
    const declared = new Set<string>(PERMISSIONS);
    const undeclared = [...apiGatedPermissions()].filter((p) => !declared.has(p));
    expect(undeclared).toEqual([]); // non-empty is RED: a permission api uses that the spec does not declare
  });

  it("every permission in the NON_API_GATED allowlist exists in PERMISSIONS — no typo, no ghost", () => {
    const declared = new Set<string>(PERMISSIONS);
    for (const p of NON_API_GATED) expect(declared.has(p)).toBe(true);
  });
});
