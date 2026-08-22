import {
  contractRequirementSatisfiedBy,
  parseSidecarManifest,
  semverCompare,
  type CertifiedRegistryIndex,
  type InstalledDocument,
  type PluginManifest,
  type SettingsDocument,
  type SidecarDep,
  type SidecarManifest,
  type SidecarRelease,
} from "./spec";

export interface SelectedSidecar {
  dependency: SidecarDep;
  release: SidecarRelease;
}

export function selectedSidecars(
  certified: CertifiedRegistryIndex,
  plugin: PluginManifest,
  settings: SettingsDocument,
  installed: InstalledDocument,
): SelectedSidecar[] {
  const selected = settings.plugins[plugin.id]?.providers ?? {};
  const releases: SelectedSidecar[] = [];
  for (const dependency of plugin.sidecars ?? []) {
    const id = selected[dependency.name];
    if (!id) throw new Error(`sidecar provider is not selected: ${plugin.id}.${dependency.name}`);
    const release = certified.index.sidecars
      .filter((candidate) => candidate.sidecar.id === id)
      .sort((left, right) => -(semverCompare(left.sidecar.version, right.sidecar.version) ?? 0))[0];
    if (!release) throw new Error(`selected sidecar release is absent: ${id}`);
    if (installed.sidecars[id]?.version === release.sidecar.version) continue;
    releases.push({ dependency, release });
  }
  return releases;
}

export function validateSelectedSidecar(
  selected: SelectedSidecar,
  raw: unknown,
): SidecarManifest {
  const parsed = parseSidecarManifest(raw);
  const identity = selected.release.sidecar;
  if (!parsed.ok || parsed.value.id !== identity.id || parsed.value.version !== identity.version) {
    throw new Error(parsed.ok ? `sidecar identity mismatch: ${identity.id}` : parsed.errors.join("; "));
  }
  if (!contractRequirementSatisfiedBy(selected.dependency.interface, parsed.value.interface)) {
    throw new Error(`sidecar interface mismatch: ${identity.id}`);
  }
  return parsed.value;
}
