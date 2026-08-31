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
 * The service declaration separates a resident service from ordinary Sidecar use. Both use exact
 * runtime dependency releases; the service declaration adds the service interface and lifecycle.
 *
 * Permissions do not separate them. A permission declaration does not identify the runtime
 * process type. Measurement (2026-07-31) found one plugin that declared `sidecar` while using
 * only app.process; the permission-based implementation omitted that headless plugin on Electron.
 *
 * The evidence of a service model is the `service` declaration — the spec already reserves that
 * field for exactly this meaning (`service: { interface }`). When it is present, the plugin's sole
 * Sidecar runtime dependency is a process service and requires no surface.
 */
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
      // What is written, and nothing derived from the permission list.
      //
      // A manifest holding the `sidecar` permission does not imply an in-process engine.
      // sidecar.json declares process and library entrypoints, and the installation resolver
      // refuses a library this host cannot load.
      //
      // Measured 2026-08-20: with the derivation here, the terminal plugin was refused for
      // requiring a loader it has no use for — every one of its units is spawned.
      requiresEngineModules: manifest.requiresEngineModules,
    },
    has,
  );
  if (unmet.length === 0) return;
  throw new Error(
    tmsg("plugin.engine.unmetNeeds", { id: manifest.id, unmet: unmet.join(", ") }),
  );
}
