import {
  contractRequirementSatisfiedBy,
  parseSidecarManifest,
  semverCompare,
  type CertifiedRegistryIndex,
  type PluginManifest,
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
  sidecars: Record<string, string> | undefined,
): SelectedSidecar[] {
  const dependencies = plugin.sidecars ?? [];
  const names = new Set(dependencies.map((dependency) => dependency.name));
  if (sidecars !== undefined) {
    for (const name of Object.keys(sidecars)) {
      if (!names.has(name)) throw new Error("unknown sidecar role: " + plugin.id + "." + name);
    }
  }
  const releases: SelectedSidecar[] = [];
  for (const dependency of dependencies) {
    const id = sidecars?.[dependency.name];
    if (!id) throw new Error("sidecar role is not connected: " + plugin.id + "." + dependency.name);
    const release = certified.index.sidecars
      .filter((candidate) => candidate.sidecar.id === id)
      .sort((left, right) => -(semverCompare(left.sidecar.version, right.sidecar.version) ?? 0))[0];
    if (!release) throw new Error(`selected sidecar release is absent: ${id}`);
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
