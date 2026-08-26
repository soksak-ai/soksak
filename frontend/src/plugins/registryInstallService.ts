import { usePlugins } from "../state/plugins";
import { publicReleaseMetadataGet, useRegistry } from "../state/registry";
import { reconcileEnvironmentRevision } from "../state/environmentEvents";
import {
  resolveRegistryRelease,
  type QualifiedRegistryEntry,
} from "./registry";
import type { CertifiedRegistry } from "./spec";
import {
  installCertifiedRegistryRelease,
  type RegistryInstallRuntimeResult,
} from "./registryInstallRuntime";
import { loadReleaseClosure } from "./registryReleaseClosure";
import { githubReleaseResolver } from "./releaseResolver";
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
  const started = startQualifiedRegistryInstall(entry);
  if (!started.ok) return started;
  return await started.completion;
}

export type RegistryInstallStartResult =
  | {
      ok: true;
      id: string;
      phase: "resolving";
      completion: Promise<RegistryInstallRuntimeResult>;
    }
  | Extract<RegistryInstallRuntimeResult, { ok: false }>;

export function startQualifiedRegistryInstall(
  entry: QualifiedRegistryEntry,
): RegistryInstallStartResult {
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
  const completion = completeQualifiedRegistryInstall(entry, source.certified).catch((cause) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    reportInstall(entry.id, { phase: "failed", completed: 0, total: 0, error: message });
    return { ok: false as const, code: "INTERNAL", message, errors: [message] };
  });
  return { ok: true, id: entry.id, phase: "resolving", completion };
}

async function completeQualifiedRegistryInstall(
  entry: QualifiedRegistryEntry,
  certified: CertifiedRegistry,
): Promise<RegistryInstallRuntimeResult> {
  const root = { kind: "plugin" as const, id: entry.id, version: entry.version, size: entry.size, sha256: entry.sha256 };
  let releases;
  try { releases = await loadReleaseClosure(root, githubReleaseResolver(publicReleaseMetadataGet)); }
  catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); reportInstall(entry.id, { phase: "failed", completed: 0, total: 0, error: message }); return { ok: false, code: "RELEASE_VERIFICATION_FAILED", message, errors: [message] }; }
  const result = await installCertifiedRegistryRelease({
    certified, root, releases,
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
  if (installed.source !== "registry") {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "a local or development record is pinned; install a registry release explicitly to replace it",
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
