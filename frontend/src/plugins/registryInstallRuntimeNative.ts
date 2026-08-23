// Production wiring for the certified archive-extraction installer.
//
// The install chain (plugin.install → installQualifiedRegistryEntry →
// installCertifiedRegistryRelease → handler) already exists; only the handler was
// the unavailable stub. This module supplies the real handler: it runs the
// dependency-closure installer against a native atomic stager and the registry
// document loader. No git clone — the native stager downloads the owner release
// archive by its pinned sha256 and extracts it under regular-files-only policy.

import { invoke } from "../framework";
import {
  declaredEntrypoints,
  installRegistryRelease,
  type RegistryArtifactStager,
  type RegistryInstallTransaction,
  type StagedRegistryArtifact,
} from "./registryInstallTransaction";
import {
  setRegistryInstallRuntime,
  type RegistryInstallRuntimeHandler,
} from "./registryInstallRuntime";
import { isArtifactTarget, parseEnvironmentDocument, type ArtifactTarget } from "./spec";

async function hostTarget(): Promise<ArtifactTarget> {
  const value = await invoke<string>("host_artifact_target");
  if (!isArtifactTarget(value)) throw new Error(`invalid host artifact target: ${String(value)}`);
  return value;
}

function artifactManifest(artifact: Parameters<typeof declaredEntrypoints>[0]): string {
  return artifact.manifest;
}

const artifactStager: RegistryArtifactStager = {
  begin: (input) =>
    invoke<RegistryInstallTransaction>("artifact_install_begin", {
      registryId: input.registryId,
      root: input.root,
    }),
  stage: (input) =>
    invoke<StagedRegistryArtifact>("artifact_install_stage", {
      transactionId: input.transactionId,
      registryId: input.registryId,
      identity: input.release,
      artifact: {
        url: input.artifact.url,
        size: input.artifact.size,
        sha256: input.artifact.sha256,
        format: input.artifact.format,
        manifest: artifactManifest(input.artifact),
        entrypoints: declaredEntrypoints(input.artifact),
      },
    }),
  readUtf8: (transactionId, handle, path) =>
    invoke<string>("artifact_install_read_utf8", { transactionId, handle, path }),
  commit: async (transactionId, expectedRevision, releases, _root) => {
    return invoke<{ revision: number }>("artifact_install_commit", {
      transactionId,
      expectedRevision,
      components: releases.map((value) => ({ ...value })),
    });
  },
  rollback: (transactionId) =>
    invoke<void>("artifact_install_rollback", { transactionId }),
};

const nativeRegistryInstall: RegistryInstallRuntimeHandler = async ({ certified, root, releases, onProgress }) => {
  let target: ArtifactTarget;
  try {
    target = await hostTarget();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, code: "HOST_TARGET_UNAVAILABLE", message, errors: [message] };
  }
  let environmentRaw: unknown;
  try {
    environmentRaw = await invoke<unknown>("environment_get");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, code: "ENVIRONMENT_UNAVAILABLE", message, errors: [message] };
  }
  const environment = parseEnvironmentDocument(environmentRaw);
  if (!environment.ok) return { ok: false, code: "ENVIRONMENT_INVALID", message: environment.errors.join("; "), errors: environment.errors };
  const result = await installRegistryRelease({
    certified,
    root: { kind: "plugin", id: root.id, version: root.version },
    releases,
    target,
    environment: environment.value,
    artifacts: artifactStager,
    onProgress,
  });
  if (result.ok) {
    return { ok: true, id: root.id, version: root.version, revision: result.revision };
  }
  return {
    ok: false,
    code: result.code,
    message: result.errors.join("; "),
    errors: result.errors,
  };
};

/** Install the native archive-extraction handler. Returns a restore function. */
export function wireNativeRegistryInstall(): () => void {
  return setRegistryInstallRuntime(nativeRegistryInstall);
}
