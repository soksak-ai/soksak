import { usePlugins } from "../state/plugins";
import { useRegistry } from "../state/registry";
import {
  resolveRegistryUnit,
  type QualifiedRegistryEntry,
} from "./registry";
import {
  installCertifiedRegistryUnit,
  type RegistryInstallRuntimeResult,
} from "./registryInstallRuntime";

export async function installQualifiedRegistryEntry(
  entry: QualifiedRegistryEntry,
): Promise<RegistryInstallRuntimeResult> {
  const source = useRegistry.getState().registries[entry.registryId];
  if (!source?.certified) {
    return {
      ok: false,
      code: "REGISTRY_NOT_CERTIFIED",
      message: `registry is not certified: ${entry.registryId}`,
    };
  }
  const result = await installCertifiedRegistryUnit({
    certified: source.certified,
    root: { kind: entry.kind, id: entry.id, version: entry.version },
  });
  if (result.ok) {
    // The archive is now published at home/plugins/<id>. Rescan the loader so the
    // freshly installed plugin becomes loadable without an app restart.
    await usePlugins.getState().reload();
  }
  return result;
}

export async function updateCertifiedRegistryPlugin(
  id: string,
  registryId?: string,
): Promise<RegistryInstallRuntimeResult> {
  const installed = usePlugins.getState().plugins[id];
  if (!installed) {
    return { ok: false, code: "TARGET_NOT_FOUND", message: `plugin not found: ${id}` };
  }
  if (installed.source === "dev") {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "a development source is not a release update target",
    };
  }
  const resolved = resolveRegistryUnit(useRegistry.getState().units, {
    unitId: id,
    kind: "plugin",
    ...(registryId ? { registryId } : {}),
  });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.reason === "not_found" ? "TARGET_NOT_FOUND" : "INVALID_PARAMS",
      message: `authenticated update release cannot be resolved: ${id}`,
      errors: resolved.candidates.map((candidate) =>
        `${candidate.registryId}/${candidate.unitId}@${candidate.version}`
      ),
    };
  }
  return await installQualifiedRegistryEntry(resolved.entry);
}
