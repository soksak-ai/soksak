import { usePlugins } from "../state/plugins";
import { publicReleaseMetadataGet, useRegistry } from "../state/registry";
import { reconcileEnvironmentRevision } from "../state/environmentEvents";
import {
  resolveRegistryRelease,
  type QualifiedRegistryEntry,
} from "./registry";
import {
  installCertifiedRegistryRelease,
  type RegistryInstallRuntimeResult,
} from "./registryInstallRuntime";
import { loadReleaseClosure } from "./registryReleaseClosure";

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
  let releases;
  try { releases = await loadReleaseClosure(entry, publicReleaseMetadataGet); }
  catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); return { ok: false, code: "RELEASE_VERIFICATION_FAILED", message, errors: [message] }; }
  const result = await installCertifiedRegistryRelease({ certified: source.certified, root: entry, releases });
  if (result.ok) {
    await reconcileEnvironmentRevision(result.revision);
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
  const resolved = resolveRegistryRelease(useRegistry.getState().entries, {
    id,
    ...(registryId ? { registryId } : {}),
  });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.reason === "not_found" ? "TARGET_NOT_FOUND" : "INVALID_PARAMS",
      message: `authenticated update release cannot be resolved: ${id}`,
      errors: resolved.candidates.map((candidate) =>
        `${candidate.registryId}/${candidate.id}@${candidate.version}`
      ),
    };
  }
  return await installQualifiedRegistryEntry(resolved.entry);
}
