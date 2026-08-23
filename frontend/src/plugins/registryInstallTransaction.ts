import {
  ANY_TARGET,
  parseManifest,
  parseSidecarManifest,
  releaseIdentity,
  type ArtifactTarget,
  type CertifiedRegistry,
  type EnvironmentDocument,
  type PluginManifest,
  type ReleaseArtifact,
  type ReleaseDocument,
  type ReleaseIdentity,
} from "./spec";

export interface RegistryInstallTransaction { transactionId: string }
export interface StagedRegistryArtifact { handle: string; sha256: string; size: number; manifestSha256: string; extraction: "regular-files-only"; verifiedEntrypoints?: readonly string[] }
export interface VerifiedInstallRelease extends ReleaseIdentity { registryId: string; sourceRepository: string; sourceCommit: string; artifactUrl: string; artifactSha256: string; target?: ArtifactTarget; manifestSha256: string; stagedHandle: string }
export interface RegistryArtifactStager {
  begin(input: { registryId: string; root: ReleaseIdentity }): Promise<RegistryInstallTransaction>;
  stage(input: { transactionId: string; registryId: string; release: ReleaseIdentity; artifact: ReleaseArtifact }): Promise<StagedRegistryArtifact>;
  readUtf8(transactionId: string, handle: string, path: string): Promise<string>;
  commit(transactionId: string, expectedRevision: number, releases: readonly VerifiedInstallRelease[], root: ReleaseIdentity): Promise<{ revision: number }>;
  rollback(transactionId: string): Promise<void>;
}
export type RegistryInstallFailureCode = "ROOT_NOT_FOUND" | "RELEASE_VERIFICATION_FAILED" | "TARGET_NOT_AVAILABLE" | "UNSAFE_EXTRACTION" | "ATOMIC_INSTALL_FAILED";
export type RegistryInstallResult = { ok: true; registryId: string; revision: number; releases: VerifiedInstallRelease[] } | { ok: false; code: RegistryInstallFailureCode; errors: string[] };
export interface RegistryInstallRequest {
  certified: CertifiedRegistry;
  root: ReleaseIdentity;
  releases: ReleaseDocument[];
  target: ArtifactTarget;
  environment: EnvironmentDocument;
  artifacts: RegistryArtifactStager;
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

function materializedExactly(environment: EnvironmentDocument, identity: ReleaseIdentity): boolean {
  const records = identity.kind === "plugin" ? environment.plugins
    : identity.kind === "sidecar" ? environment.sidecars
      : identity.kind === "kit" ? environment.kits : {};
  return records[identity.id]?.version === identity.version;
}

async function stageRelease(request: RegistryInstallRequest, transactionId: string, release: ReleaseDocument) {
  const identity = releaseIdentity(release);
  const artifact = artifactFor(release, request.target);
  const staged = await request.artifacts.stage({ transactionId, registryId: request.certified.registry.id, release: identity, artifact });
  verifyEvidence(staged, artifact);
  const raw = JSON.parse(await request.artifacts.readUtf8(transactionId, staged.handle, artifact.manifest));
  const verified: VerifiedInstallRelease = Object.freeze({
    ...identity, registryId: request.certified.registry.id,
    sourceRepository: release.source.repository, sourceCommit: release.source.commit,
    artifactUrl: artifact.url, artifactSha256: artifact.sha256,
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

export async function installRegistryRelease(request: RegistryInstallRequest): Promise<RegistryInstallResult> {
  let transactionId: string | null = null;
  try {
    const root = exactRelease(request.releases, request.root);
    if (!root) throw new InstallFailure("ROOT_NOT_FOUND", ["release absent from certified registry"]);
    if (request.root.kind === "contract" || request.root.kind === "spec") {
      throw new InstallFailure("RELEASE_VERIFICATION_FAILED", [request.root.kind + " releases are validation inputs, not runtime installations"]);
    }
    if (materializedExactly(request.environment, request.root)) {
      return { ok: true, registryId: request.certified.registry.id, revision: request.environment.revision, releases: [] };
    }

    const transaction = await request.artifacts.begin({ registryId: request.certified.registry.id, root: request.root });
    transactionId = transaction.transactionId;
    const verified: VerifiedInstallRelease[] = [];
    const seen = new Set<string>();
    const queue: ReleaseDocument[] = [root];

    while (queue.length) {
      const release = queue.shift()!;
      const identity = releaseIdentity(release);
      const key = identity.kind + ":" + identity.id + "@" + identity.version;
      if (seen.has(key) || materializedExactly(request.environment, identity)) continue;
      seen.add(key);
      const staged = await stageRelease(request, transactionId, release);

      if (identity.kind === "plugin") {
        const manifest = pluginManifest(staged.raw, identity);
        if (JSON.stringify(manifest.runtimeDependencies ?? null) !== JSON.stringify(release.runtimeDependencies ?? null)) throw new InstallFailure("RELEASE_VERIFICATION_FAILED", ["plugin runtime dependencies differ from its release"]);
      } else if (identity.kind === "sidecar") {
        const parsed = parseSidecarManifest(staged.raw);
        if (!parsed.ok || parsed.value.id !== identity.id || parsed.value.version !== identity.version) {
          throw new InstallFailure("RELEASE_VERIFICATION_FAILED", parsed.ok ? ["sidecar identity mismatch"] : parsed.errors);
        }
      }
      for (const dependency of release.runtimeDependencies?.plugins ?? []) { const next = exactRelease(request.releases, { kind: "plugin", id: dependency.id, version: dependency.version }); if (!next) throw new InstallFailure("RELEASE_VERIFICATION_FAILED", ["plugin dependency is absent: " + dependency.id]); queue.push(next); }
      for (const dependency of release.runtimeDependencies?.sidecars ?? []) { const next = exactRelease(request.releases, { kind: "sidecar", id: dependency.id, version: dependency.version }); if (!next) throw new InstallFailure("RELEASE_VERIFICATION_FAILED", ["sidecar dependency is absent: " + dependency.id]); queue.push(next); }
      verified.push(staged.verified);
    }

    const committed = await request.artifacts.commit(transactionId, request.environment.revision, verified, request.root);
    transactionId = null;
    return { ok: true, registryId: request.certified.registry.id, revision: committed.revision, releases: verified };
  } catch (cause) {
    if (transactionId !== null) await request.artifacts.rollback(transactionId).catch(() => {});
    if (cause instanceof InstallFailure) return { ok: false, code: cause.code, errors: cause.errors };
    return { ok: false, code: "ATOMIC_INSTALL_FAILED", errors: [String(cause)] };
  }
}
