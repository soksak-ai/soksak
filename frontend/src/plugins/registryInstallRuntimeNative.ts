// Production wiring for the certified archive-extraction installer.
//
// The install chain (plugin.install → installQualifiedRegistryEntry →
// installCertifiedRegistryUnit → handler) already exists; only the handler was
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
import { ANY_TARGET, isUnitTarget, type UnitTarget } from "./spec";

// The frontend cannot recompile a sidecar; a plugin selects the ANY_TARGET artifact
// and never reads this. Only a sidecar in the closure needs the real host triple,
// which the native side reports from its own build target. If that command is absent
// (an older core), a plugin-only install still resolves and a sidecar install fails
// closed at artifact selection rather than fetching the wrong binary.
async function hostTarget(): Promise<UnitTarget> {
  try {
    const value = await invoke<string>("host_unit_target");
    if (isUnitTarget(value)) return value;
  } catch {
    // fall through to the portable target
  }
  return ANY_TARGET;
}

function documentLoader(registryId: string): RegistryDocumentLoader {
  return { load: (url) => loadRegistryResourceBytes(registryId, url) };
}

const artifactStager: RegistryArtifactStager = {
  begin: (input) =>
    invoke<RegistryInstallTransaction>("unit_install_begin", {
      registryId: input.registryId,
      root: input.root,
    }),
  stage: (input) =>
    invoke<StagedRegistryArtifact>("unit_install_stage", {
      transactionId: input.transactionId,
      registryId: input.registryId,
      unit: input.unit,
      artifact: {
        url: input.artifact.url,
        sha256: input.artifact.sha256,
        format: input.artifact.format,
        entrypoints: declaredEntrypoints(input.artifact),
      },
    }),
  readUtf8: (transactionId, handle, path) =>
    invoke<string>("unit_install_read_utf8", { transactionId, handle, path }),
  commit: (transactionId, units) =>
    invoke<{ generation: string }>("unit_install_commit", {
      transactionId,
      units,
    }),
  rollback: (transactionId) =>
    invoke<void>("unit_install_rollback", { transactionId }),
};

const nativeRegistryInstall: RegistryInstallRuntimeHandler = async ({ certified, root }) => {
  const registryId = certified.index.registryId;
  const result = await installRegistryClosure({
    certified,
    root,
    target: await hostTarget(),
    documents: documentLoader(registryId),
    artifacts: artifactStager,
  });
  if (result.ok) {
    return { ok: true, id: root.id, version: root.version, generation: result.generation };
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
