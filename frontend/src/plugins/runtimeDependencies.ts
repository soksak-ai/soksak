import type { ExactReference, PluginManifest } from "./spec";
// A manifest declares dependency intent: {id, version} and nothing else.
export function runtimePluginReferences(manifest: PluginManifest): readonly ExactReference[] { return manifest.runtimeDependencies?.plugins ?? []; }
export function runtimeSidecarReferences(manifest: PluginManifest): readonly ExactReference[] { return manifest.runtimeDependencies?.sidecars ?? []; }
export function runtimePluginRequirements(manifest: PluginManifest): Record<string, string> { return Object.fromEntries(runtimePluginReferences(manifest).map((reference) => [reference.id, reference.version])); }
