import type { PluginManifest, ReleaseReference } from "./spec";
export function runtimePluginReferences(manifest: PluginManifest): readonly ReleaseReference[] { return manifest.runtimeDependencies?.plugins ?? []; }
export function runtimeSidecarReferences(manifest: PluginManifest): readonly ReleaseReference[] { return manifest.runtimeDependencies?.sidecars ?? []; }
export function runtimePluginRequirements(manifest: PluginManifest): Record<string, string> { return Object.fromEntries(runtimePluginReferences(manifest).map((reference) => [reference.id, reference.version])); }
