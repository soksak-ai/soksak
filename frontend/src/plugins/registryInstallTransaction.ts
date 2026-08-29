import {
  ANY_TARGET,
  parseManifest,
  parseSidecarManifest,
  releaseIdentity,
  type ArtifactTarget,
  type PluginManifest,
  type ReleaseArtifact,
  type ReleaseDocument,
  type ReleaseIdentity,
} from "./spec";
import type { HostEnvironment } from "../state/environmentEvents";

export interface RegistryInstallTransaction { transactionId: string }
export interface StagedRegistryArtifact { handle: string; sha256: string; size: number; manifestSha256: string; extraction: "regular-files-only"; verifiedEntrypoints?: readonly string[] }
export interface VerifiedInstallRelease extends ReleaseIdentity { registryId: string; sourceRepository: string; sourceCommit: string; artifactSha256: string; target?: ArtifactTarget; manifestSha256: string; stagedHandle: string }
export interface RegistryArtifactStager {
  begin(input: { registryId: string; root: ReleaseIdentity; localStore?: string }): Promise<RegistryInstallTransaction>;
  // The stager derives the artifact location from the release identity and artifact.file: the
  // published directory, or the store addressed at begin.
  stage(input: { transactionId: string; registryId: string; release: ReleaseIdentity; artifact: ReleaseArtifact }): Promise<StagedRegistryArtifact>;
  readUtf8(transactionId: string, handle: string, path: string): Promise<string>;
  commit(transactionId: string, expectedRevision: number, releases: readonly VerifiedInstallRelease[], root: ReleaseIdentity): Promise<{ revision: number }>;
  rollback(transactionId: string): Promise<void>;
}
export type RegistryInstallFailureCode = "ROOT_NOT_FOUND" | "RELEASE_VERIFICATION_FAILED" | "TARGET_NOT_AVAILABLE" | "UNSAFE_EXTRACTION" | "ATOMIC_INSTALL_FAILED";
export type RegistryInstallResult = { ok: true; registryId: string; revision: number; releases: VerifiedInstallRelease[] } | { ok: false; code: RegistryInstallFailureCode; errors: string[] };
export interface RegistryInstallRequest {
  sourceId: string;
  localStore?: string;
  root: ReleaseIdentity;
  releases: ReleaseDocument[];
  target: ArtifactTarget;
  environment: HostEnvironment;
  artifacts: RegistryArtifactStager;
  onProgress?: (progress: { phase: "staging" | "committing"; completed: number; total: number; componentId?: string }) => void;
}
export interface RegistryBatchInstallRequest extends Omit<RegistryInstallRequest, "root"> {
  roots: ReleaseIdentity[];
}

class InstallFailure extends Error {
  constructor(readonly code: RegistryInstallFailureCode, readonly errors: string[]) {
    super(errors.join("; "));
  }
}

function exactRelease(releases: readonly ReleaseDocument[], wanted: ReleaseIdentity): ReleaseDocument | null {
  return releases.find((release) => {
    const identity = releaseIdentity(release);
    return identity.kind === wanted.kind && identity.id === wanted.id && identity.version === wanted.version;
  }) ?? null;
}

function artifactFor(release: ReleaseDocument, target: ArtifactTarget): ReleaseArtifact {
  const artifact = release.artifacts.find((value) => value.target === target)
    ?? release.artifacts.find((value) => value.target === ANY_TARGET);
  if (!artifact) throw new InstallFailure("TARGET_NOT_AVAILABLE", ["release has no artifact for " + target]);
  return artifact;
}

export function declaredEntrypoints(artifact: ReleaseArtifact): string[] { return [artifact.manifest]; }

function verifyEvidence(staged: StagedRegistryArtifact, artifact: ReleaseArtifact): void {
  const errors: string[] = [];
  if (staged.extraction !== "regular-files-only") errors.push("native extraction policy missing");
  if (staged.sha256 !== artifact.sha256) errors.push("artifact digest mismatch");
  if (staged.size !== artifact.size) errors.push("artifact size mismatch");
  if (!/^[a-f0-9]{64}$/.test(staged.manifestSha256)) errors.push("manifest digest missing");
  if (!staged.verifiedEntrypoints?.includes(artifact.manifest)) errors.push("manifest entrypoint not verified");
  if (errors.length) throw new InstallFailure("UNSAFE_EXTRACTION", errors);
}

function materializedExactly(environment: HostEnvironment, identity: ReleaseIdentity, digest: string): boolean {
  const records = identity.kind === "plugin" ? environment.plugins
    : identity.kind === "sidecar" ? environment.sidecars : {};
  const record = records[identity.id];
  return record?.version === identity.version && record.artifactSha256 === digest;
}

function releaseMaterialized(request: Pick<RegistryInstallRequest, "environment" | "target">, release: ReleaseDocument): boolean {
  const identity = releaseIdentity(release);
  if (identity.kind !== "plugin" && identity.kind !== "sidecar") return false;
  return materializedExactly(request.environment, identity, artifactFor(release, request.target).sha256);
}

function pendingReleaseCount(request: RegistryBatchInstallRequest): number {
  const unique = new Set<string>();
  for (const release of request.releases) {
    const identity = releaseIdentity(release);
    if ((identity.kind !== "plugin" && identity.kind !== "sidecar") || releaseMaterialized(request, release)) continue;
    unique.add(identity.kind + ":" + identity.id + "@" + identity.version);
  }
  return unique.size;
}

async function stageRelease(request: Pick<RegistryInstallRequest, "artifacts" | "sourceId" | "target">, transactionId: string, release: ReleaseDocument) {
  const identity = releaseIdentity(release);
  const artifact = artifactFor(release, request.target);
  const staged = await request.artifacts.stage({ transactionId, registryId: request.sourceId, release: identity, artifact });
  verifyEvidence(staged, artifact);
  const raw = JSON.parse(await request.artifacts.readUtf8(transactionId, staged.handle, artifact.manifest));
  const verified: VerifiedInstallRelease = Object.freeze({
    ...identity, registryId: request.sourceId,
    sourceRepository: release.source.repository, sourceCommit: release.source.commit,
    artifactSha256: artifact.sha256,
    ...(identity.kind === "sidecar" ? { target: artifact.target } : {}),
    manifestSha256: staged.manifestSha256, stagedHandle: staged.handle,
  });
  return { raw, verified };
}

function pluginManifest(raw: unknown, identity: ReleaseIdentity): PluginManifest {
  const parsed = parseManifest(raw, identity.id);
  if (!parsed.validation.ok || parsed.manifest?.version !== identity.version) {
    throw new InstallFailure("RELEASE_VERIFICATION_FAILED", parsed.validation.errors);
  }
  return parsed.manifest;
}

// The manifest declares intent {id, version}; the release records the fact {id, version, size, sha256}.
// Per group, the two sets of {id, version} are equal: nothing declared is missing, nothing undeclared is recorded.
function dependencyMismatches(manifest: PluginManifest, release: ReleaseDocument): string[] {
  const errors: string[] = [];
  for (const group of ["plugins", "sidecars"] as const) {
    const declared = new Set((manifest.runtimeDependencies?.[group] ?? []).map((value) => `${value.id}@${value.version}`));
    const recorded = new Set((release.runtimeDependencies?.[group] ?? []).map((value) => `${value.id}@${value.version}`));
    for (const value of declared) if (!recorded.has(value)) errors.push(`plugin.json declares ${group} dependency ${value} that release.json does not record`);
    for (const value of recorded) if (!declared.has(value)) errors.push(`release.json records ${group} dependency ${value} that plugin.json does not declare`);
  }
  return errors;
}

export async function installRegistryRelease(request: RegistryInstallRequest): Promise<RegistryInstallResult> {
  const { root, ...shared } = request;
  return installRegistryReleases({ ...shared, roots: [root] });
}

export async function installRegistryReleases(request: RegistryBatchInstallRequest): Promise<RegistryInstallResult> {
  let transactionId: string | null = null;
  try {
    if (request.roots.length === 0) throw new InstallFailure("ROOT_NOT_FOUND", ["installation has no release roots"]);
    const roots = request.roots.map((identity) => {
      const release = exactRelease(request.releases, identity);
      if (!release) throw new InstallFailure("ROOT_NOT_FOUND", [`release root is absent: ${identity.id}@${identity.version}`]);
      if (identity.kind === "contract" || identity.kind === "spec" || identity.kind === "kit") {
        throw new InstallFailure("RELEASE_VERIFICATION_FAILED", [identity.kind + " releases are validation inputs, not runtime installations"]);
      }
      return release;
    });
    const transactionRoot = request.roots[0];
    const transaction = await request.artifacts.begin({ registryId: request.sourceId, root: transactionRoot, ...(request.localStore ? { localStore: request.localStore } : {}) });
    transactionId = transaction.transactionId;
    const verified: VerifiedInstallRelease[] = [];
    const total = pendingReleaseCount(request);
    const seen = new Set<string>();
    const queue: ReleaseDocument[] = [...roots];

    while (queue.length) {
      const release = queue.shift()!;
      const identity = releaseIdentity(release);
      const key = identity.kind + ":" + identity.id + "@" + identity.version;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!releaseMaterialized(request, release)) {
        request.onProgress?.({ phase: "staging", completed: verified.length, total, componentId: identity.id });
        const staged = await stageRelease(request, transactionId, release);

        if (identity.kind === "plugin") {
          const mismatches = dependencyMismatches(pluginManifest(staged.raw, identity), release);
          if (mismatches.length) throw new InstallFailure("RELEASE_VERIFICATION_FAILED", mismatches);
        } else if (identity.kind === "sidecar") {
          const parsed = parseSidecarManifest(staged.raw);
          if (!parsed.ok || parsed.value.id !== identity.id || parsed.value.version !== identity.version) {
            throw new InstallFailure("RELEASE_VERIFICATION_FAILED", parsed.ok ? ["sidecar identity mismatch"] : parsed.errors);
          }
        }
        verified.push(staged.verified);
        request.onProgress?.({ phase: "staging", completed: verified.length, total, componentId: identity.id });
      }
      for (const dependency of release.runtimeDependencies?.plugins ?? []) { const next = exactRelease(request.releases, { kind: "plugin", id: dependency.id, version: dependency.version }); if (!next) throw new InstallFailure("RELEASE_VERIFICATION_FAILED", ["plugin dependency is absent: " + dependency.id]); queue.push(next); }
      for (const dependency of release.runtimeDependencies?.sidecars ?? []) { const next = exactRelease(request.releases, { kind: "sidecar", id: dependency.id, version: dependency.version }); if (!next) throw new InstallFailure("RELEASE_VERIFICATION_FAILED", ["sidecar dependency is absent: " + dependency.id]); queue.push(next); }
    }
    if (verified.length === 0) return { ok: true, registryId: request.sourceId, revision: request.environment.revision, releases: [] };

    request.onProgress?.({ phase: "committing", completed: verified.length, total });
    const committed = await request.artifacts.commit(transactionId, request.environment.revision, verified, transactionRoot);
    transactionId = null;
    return { ok: true, registryId: request.sourceId, revision: committed.revision, releases: verified };
  } catch (cause) {
    if (transactionId !== null) await request.artifacts.rollback(transactionId).catch(() => {});
    if (cause instanceof InstallFailure) return { ok: false, code: cause.code, errors: cause.errors };
    return { ok: false, code: "ATOMIC_INSTALL_FAILED", errors: [String(cause)] };
  }
}
