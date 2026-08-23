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
import { beginPluginInstall, setPluginInstallProgress } from "./registryInstallProgress";
import { publishActivity } from "../state/activityFeed";

function reportInstall(pluginId: string, progress: Omit<Parameters<typeof setPluginInstallProgress>[0], "pluginId">): void {
  const value = { pluginId, ...progress };
  setPluginInstallProgress(value);
  publishActivity("plugin.install.progress", "core", value);
}

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
  if (!beginPluginInstall(entry.id)) {
    return { ok: false, code: "INSTALL_IN_PROGRESS", message: `plugin installation is already running: ${entry.id}` };
  }
  let releases;
  try { releases = await loadReleaseClosure(entry, publicReleaseMetadataGet); }
  catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); reportInstall(entry.id, { phase: "failed", completed: 0, total: 0, error: message }); return { ok: false, code: "RELEASE_VERIFICATION_FAILED", message, errors: [message] }; }
  const result = await installCertifiedRegistryRelease({
    certified: source.certified, root: entry, releases,
    onProgress: (progress) => reportInstall(entry.id, progress),
  });
  if (result.ok) {
    await reconcileEnvironmentRevision(result.revision);
    reportInstall(entry.id, { phase: "installed", completed: releases.length, total: releases.length });
  } else {
    reportInstall(entry.id, { phase: "failed", completed: 0, total: releases.length, error: result.message });
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
