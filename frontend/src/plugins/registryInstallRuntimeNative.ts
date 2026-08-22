// Production wiring for the certified archive-extraction installer.
//
// The install chain (plugin.install → installQualifiedRegistryEntry →
// installCertifiedRegistryRelease → handler) already exists; only the handler was
// the unavailable stub. This module supplies the real handler: it runs the
// dependency-closure installer against a native atomic stager and the registry
// document loader. No git clone — the native stager downloads the owner release
// archive by its pinned sha256 and extracts it under regular-files-only policy.

import { invoke } from "../framework";
import { loadRegistryResourceBytes } from "../state/registry";
import {
  declaredEntrypoints,
  installRegistryClosure,
  type RegistryArtifactStager,
  type RegistryDocumentLoader,
  type RegistryInstallTransaction,
  type StagedRegistryArtifact,
} from "./registryInstaller";
import {
  setRegistryInstallRuntime,
  type RegistryInstallRuntimeHandler,
} from "./registryInstallRuntime";
import { isArtifactTarget, type ArtifactTarget } from "./spec";

async function hostTarget(): Promise<ArtifactTarget> {
  const value = await invoke<string>("host_artifact_target");
  if (!isArtifactTarget(value)) throw new Error(`invalid host artifact target: ${String(value)}`);
  return value;
}

function artifactManifest(artifact: Parameters<typeof declaredEntrypoints>[0]): string {
  if (artifact.entrypoint.kind === "plugin") return artifact.entrypoint.manifest;
  if (artifact.entrypoint.kind === "kit") return artifact.entrypoint.packageManifest;
  return "sidecar.json";
}

function documentLoader(registryId: string): RegistryDocumentLoader {
  return { load: (url) => loadRegistryResourceBytes(registryId, url) };
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
  commit: async (transactionId, releases) => {
    const installed = await invoke<{ revision: number }>("installed_get");
    const expectedRevision = installed.revision;
    const plugins = releases.filter((value) => value.kind === "plugin").map((value) => ({
      plugin: { id: value.id, version: value.version },
      registryId: value.registryId,
      sourceRepository: value.sourceRepository,
      sourceCommit: value.sourceCommit,
      artifactUrl: value.artifactUrl,
      artifactSha256: value.artifactSha256,
      manifestSha256: value.manifestSha256,
      stagedHandle: value.stagedHandle,
    }));
    const sidecars = releases.filter((value) => value.kind === "sidecar").map((value) => ({
      sidecar: { id: value.id, version: value.version },
      registryId: value.registryId,
      sourceRepository: value.sourceRepository,
      sourceCommit: value.sourceCommit,
      artifactUrl: value.artifactUrl,
      artifactSha256: value.artifactSha256,
      target: value.target,
      manifestSha256: value.manifestSha256,
      stagedHandle: value.stagedHandle,
    }));
    const kits = releases.filter((value) => value.kind === "kit").map((value) => ({
      kit: { id: value.id, version: value.version },
      registryId: value.registryId,
      sourceRepository: value.sourceRepository,
      sourceCommit: value.sourceCommit,
      artifactUrl: value.artifactUrl,
      artifactSha256: value.artifactSha256,
      manifestSha256: value.manifestSha256,
      stagedHandle: value.stagedHandle,
    }));
    return invoke<{ revision: number }>("artifact_install_commit", {
      transactionId,
      expectedRevision,
      plugins,
      sidecars,
      kits,
    });
  },
  rollback: (transactionId) =>
    invoke<void>("artifact_install_rollback", { transactionId }),
};

const nativeRegistryInstall: RegistryInstallRuntimeHandler = async ({ certified, root }) => {
  const registryId = certified.index.registryId;
  let target: ArtifactTarget;
  try {
    target = await hostTarget();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, code: "HOST_TARGET_UNAVAILABLE", message, errors: [message] };
  }
  const result = await installRegistryClosure({
    certified,
    root,
    target,
    documents: documentLoader(registryId),
    artifacts: artifactStager,
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
