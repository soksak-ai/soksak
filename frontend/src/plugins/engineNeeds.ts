// An unmet requirement **blocks loading.**
//
// The grade contract (unmetNeeds) existed and both frameworks filled in their own provision
// (engineProvision), but nothing compared the two. A contract written and never read is the same
// as no contract — meanwhile a plugin that presumes a native child surface loaded as-is on a
// framework without one, and the screen showed only "engine surface creation failed" (measured
// 2026-07-31, Electron).
//
// Never block silently. What was missing must be recorded by name so the next person does not
// investigate it again, and so the user reads it as "a surface this framework does not have"
// rather than "broken".

import { tmsg } from "../i18n";
import { unmetNeeds, type EngineProvision, type PluginManifest } from "./spec";

/**
 * Does it consume an engine-model sidecar — **that alone is a surface requirement.**
 *
 * The model table in docs/SIDECARS.md §1 states it: engine = in-process dylib, and its Surface
 * column is "renders into pane surfaces (NSView)". By that definition an engine without a surface
 * does not exist.
 *
 * So authors are not made to write `requiresNativeChildWebview: true` by hand a second time. Two
 * copies stay quiet until they diverge, and they did (measured 2026-07-31: a plugin using the
 * engine while declaring no requirement loaded as-is on Electron and left only "engine surface
 * creation failed").
 *
 * The **consumption model** is what separates them. Both models share the same `sidecars[]`, so
 * that array alone cannot separate them.
 *
 * Permissions do not separate them either. A permission is **a door left open**, not a trace of
 * passage — measured (2026-07-31): one plugin over-declared the `sidecar` permission while
 * actually being a service model that uses app.process only, and the first cut based on
 * permissions dropped that headless plugin entirely on Electron.
 *
 * The evidence of a service model is the `service` declaration — the spec already reserves that
 * field for exactly this meaning (`service: { sidecar, interface }`). When it is present, this
 * plugin's sidecar consumption is a process spawn and requires no surface.
 */
function consumesEngineSidecar(manifest: PluginManifest): boolean {
  const sidecars = manifest.sidecars ?? [];
  if (sidecars.length === 0) return false;
  if (manifest.service !== undefined) return false;
  const permissions: readonly string[] = manifest.permissions ?? [];
  return permissions.includes("sidecar");
}

/**
 * Refuse, with the name, when this framework cannot meet a requirement.
 *
 * With no requirement, do nothing — a rule that also catches unrelated surfaces gets turned off.
 */
export function enforceEngineNeeds(
  manifest: PluginManifest,
  has: EngineProvision,
): void {
  const unmet = unmetNeeds(
    {
      requiresEngine: manifest.requiresEngine,
      requiresNativeChildWebview: manifest.requiresNativeChildWebview,
      // Union of what is written and what is **derived**. Without the derivation, the author's
      // memory is the only defence.
      //
      // This is the **module loading** axis, not the child view axis. Of the two composition modes
      // (SIDECARS.md §8), offscreen uses no child view but still needs module loading — merging
      // the two axes rejects that consumer for the wrong reason, and a false reason sends the next
      // person to fix the wrong thing.
      requiresEngineModules:
        manifest.requiresEngineModules || consumesEngineSidecar(manifest),
    },
    has,
  );
  if (unmet.length === 0) return;
  throw new Error(
    tmsg("plugin.engine.unmetNeeds", { id: manifest.id, unmet: unmet.join(", ") }),
  );
}
