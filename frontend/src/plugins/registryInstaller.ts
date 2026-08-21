import {
  ANY_TARGET,
  githubReleaseAssetBelongsTo,
  isSafeRelativeUnitPath,
  parseManifest,
  parseReleaseManifest,
  resolveRegistryDependency,
  semverCompare,
  semverSatisfies,
  verifyPluginRuntimeDependencyProjection,
  verifyRegistryUnitRelease,
  type CertifiedRegistryIndex,
  type RegistryUnitIdentity,
  type RegistryUnitIndexEntry,
  type UnitReleaseArtifact,
  type UnitReleaseManifest,
  type UnitTarget,
} from "./spec";

export interface RegistryDocumentLoader {
  load(url: string): Promise<Uint8Array>;
}

export interface RegistryInstallTransaction {
  transactionId: string;
}

export interface StagedRegistryArtifact {
  handle: string;
  sha256: string;
  extraction: "regular-files-only";
  /** Declared entrypoint paths that the native extractor proved are regular files. */
  verifiedEntrypoints?: readonly string[];
}

export interface RegistryArtifactStager {
  begin(input: {
    registryId: string;
    root: RegistryUnitIdentity;
  }): Promise<RegistryInstallTransaction>;
  stage(input: {
    transactionId: string;
    registryId: string;
    unit: RegistryUnitIdentity;
    artifact: UnitReleaseArtifact;
  }): Promise<StagedRegistryArtifact>;
  readUtf8(transactionId: string, handle: string, path: string): Promise<string>;
  commit(
    transactionId: string,
    units: readonly VerifiedInstallUnit[],
  ): Promise<{ generation: number }>;
  rollback(transactionId: string): Promise<void>;
}

export interface VerifiedInstallUnit extends RegistryUnitIdentity {
  registryId: string;
  sourceRepository: string;
  sourceCommit: string;
  releaseTag: string;
  artifactUrl: string;
  artifactSha256: string;
  stagedHandle: string;
}

export type RegistryInstallFailureCode =
  | "ROOT_NOT_FOUND"
  | "DEPENDENCY_RESOLUTION_FAILED"
  | "DEPENDENCY_CYCLE"
  | "RELEASE_VERIFICATION_FAILED"
  | "TARGET_NOT_AVAILABLE"
  | "UNSAFE_EXTRACTION"
  | "PLUGIN_MANIFEST_INVALID"
  | "ATOMIC_INSTALL_FAILED";

export type RegistryInstallResult =
  | {
      ok: true;
      registryId: string;
      generation: number;
      units: readonly VerifiedInstallUnit[];
    }
  | {
      ok: false;
      code: RegistryInstallFailureCode;
      errors: string[];
    };

export interface RegistryInstallRequest {
  certified: CertifiedRegistryIndex;
  root: RegistryUnitIdentity;
  target: UnitTarget;
  documents: RegistryDocumentLoader;
  artifacts: RegistryArtifactStager;
}

class InstallFailure extends Error {
  constructor(
    readonly code: RegistryInstallFailureCode,
    readonly errors: string[],
  ) {
    super(errors.join("; "));
  }
}

interface LoadedRelease {
  entry: RegistryUnitIndexEntry;
  manifestBytes: Uint8Array;
  release: UnitReleaseManifest;
}

function unitKey(unit: Pick<RegistryUnitIdentity, "kind" | "id">): string {
  return `${unit.kind}\u0000${unit.id}`;
}

function exactKey(unit: RegistryUnitIdentity): string {
  return `${unitKey(unit)}\u0000${unit.version}`;
}

function identity(entry: RegistryUnitIndexEntry): RegistryUnitIdentity {
  return { kind: entry.kind, id: entry.id, version: entry.version };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new InstallFailure("RELEASE_VERIFICATION_FAILED", [
      `${label}: invalid UTF-8 JSON (${String(cause)})`,
    ]);
  }
}

function sameSelection(
  left: ReadonlyMap<string, RegistryUnitIndexEntry>,
  right: ReadonlyMap<string, RegistryUnitIndexEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key)?.version !== value.version) return false;
  }
  return true;
}

// Which artifact runs here is what the artifact declares, never what kind of unit declared it.
//
// Every artifact states its own `target`, and the release parser already holds the shapes apart: a
// sidecar release declares native triples, every other kind declares exactly one `any`. Reading the
// kind instead re-derives a fact already written down, and the two can disagree — the day a
// plugin ships a per-target artifact, a rule keyed on the kind quietly picks the wrong one, or
// reports none at all while the right one is in the list.
//
// The host's own triple wins over `any`, so a unit that ships both is served the specific build.
function selectArtifact(
  release: UnitReleaseManifest,
  target: UnitTarget,
): UnitReleaseArtifact {
  const artifact =
    release.artifacts.find((candidate) => candidate.target === target) ??
    release.artifacts.find((candidate) => candidate.target === ANY_TARGET);
  if (!artifact) {
    throw new InstallFailure("TARGET_NOT_AVAILABLE", [
      `${release.kind}:${release.id}@${release.version} declares no artifact for ${target} ` +
        `and none for ${ANY_TARGET}`,
    ]);
  }
  return artifact;
}

export function declaredEntrypoints(artifact: UnitReleaseArtifact): string[] {
  const entrypoint = artifact.entrypoint;
  if (entrypoint.kind === "plugin") return [entrypoint.manifest];
  if (entrypoint.kind === "kit") return [entrypoint.packageManifest];
  return [
    ...(entrypoint.process ?? []).map((value) => value.path),
    ...(entrypoint.library ?? []).map((value) => value.path),
  ].sort();
}

function verifyStagingEvidence(
  staged: StagedRegistryArtifact,
  artifact: UnitReleaseArtifact,
): void {
  const errors: string[] = [];
  if (staged.extraction !== "regular-files-only") {
    errors.push("native extraction did not attest the regular-file-only policy");
  }
  if (staged.sha256 !== artifact.sha256) {
    errors.push("staged artifact digest differs from the owner release digest");
  }
  if (!staged.handle) errors.push("native staging handle is empty");
  const declared = declaredEntrypoints(artifact);
  if (declared.some((path) => !isSafeRelativeUnitPath(path))) {
    errors.push("owner release contains an unsafe entrypoint path");
  }
  if (staged.verifiedEntrypoints !== undefined) {
    const verified = [...staged.verifiedEntrypoints].sort();
    if (JSON.stringify(verified) !== JSON.stringify(declared)) {
      errors.push("native extraction did not verify the complete declared entrypoint set");
    }
  }
  if (errors.length > 0) throw new InstallFailure("UNSAFE_EXTRACTION", errors);
}


// The staged plugin manifest is parsed and checked against the release it arrived in.
//
// It also answered the contracts the plugin implements until 2026-08-16, and that answer rode into
// the release verification. The manifest declares no interface any more (C3, C4); the version match
// and the dependency projection are what this checks, and both are about the release itself.
async function verifyStagedPluginManifest(
  stager: RegistryArtifactStager,
  transactionId: string,
  staged: StagedRegistryArtifact,
  release: UnitReleaseManifest,
  artifact: UnitReleaseArtifact,
): Promise<void> {
  if (release.kind !== "plugin" || artifact.entrypoint.kind !== "plugin") return;
  let raw: unknown;
  try {
    raw = JSON.parse(await stager.readUtf8(
      transactionId,
      staged.handle,
      artifact.entrypoint.manifest,
    ));
  } catch (cause) {
    throw new InstallFailure("PLUGIN_MANIFEST_INVALID", [
      `plugin:${release.id}: unreadable plugin manifest (${String(cause)})`,
    ]);
  }
  const parsed = parseManifest(raw, release.id);
  if (!parsed.manifest) {
    throw new InstallFailure("PLUGIN_MANIFEST_INVALID", parsed.validation.errors);
  }
  if (parsed.manifest.version !== release.version) {
    throw new InstallFailure("PLUGIN_MANIFEST_INVALID", [
      `plugin manifest version ${parsed.manifest.version} differs from release ${release.version}`,
    ]);
  }
  const projection = verifyPluginRuntimeDependencyProjection(
    parsed.manifest.dependencies,
    release,
  );
  if (!projection.ok) {
    throw new InstallFailure("PLUGIN_MANIFEST_INVALID", projection.errors);
  }
}

function topologicalOrder(
  selected: ReadonlyMap<string, RegistryUnitIndexEntry>,
  loaded: ReadonlyMap<string, LoadedRelease>,
  root: RegistryUnitIdentity,
): RegistryUnitIndexEntry[] {
  const result: RegistryUnitIndexEntry[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (entry: RegistryUnitIndexEntry): void => {
    const key = unitKey(entry);
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      throw new InstallFailure("DEPENDENCY_CYCLE", [
        `dependency cycle contains ${entry.kind}:${entry.id}`,
      ]);
    }
    visiting.add(key);
    const envelope = loaded.get(exactKey(identity(entry)));
    if (!envelope) {
      throw new InstallFailure("RELEASE_VERIFICATION_FAILED", [
        `owner release was not loaded for ${entry.kind}:${entry.id}@${entry.version}`,
      ]);
    }
    for (const dependency of envelope.release.dependencies) {
      const child = selected.get(unitKey(dependency));
      if (!child) {
        throw new InstallFailure("DEPENDENCY_RESOLUTION_FAILED", [
          `resolved closure omitted ${dependency.kind}:${dependency.id}`,
        ]);
      }
      visit(child);
    }
    visiting.delete(key);
    visited.add(key);
    result.push(entry);
  };

  const rootEntry = selected.get(unitKey(root));
  if (!rootEntry) throw new InstallFailure("ROOT_NOT_FOUND", ["root unit disappeared from closure"]);
  visit(rootEntry);
  return result;
}

async function solveClosure(
  certified: CertifiedRegistryIndex,
  root: RegistryUnitIdentity,
  documents: RegistryDocumentLoader,
): Promise<{ order: RegistryUnitIndexEntry[]; loaded: Map<string, LoadedRelease> }> {
  const rootEntry = certified.index.units.find((candidate) =>
    candidate.kind === root.kind && candidate.id === root.id && candidate.version === root.version
  );
  if (!rootEntry) {
    throw new InstallFailure("ROOT_NOT_FOUND", [
      `origin registry ${certified.index.registryId} does not contain ${root.kind}:${root.id}@${root.version}`,
    ]);
  }
  const cache = new Map<string, LoadedRelease>();
  const load = async (entry: RegistryUnitIndexEntry): Promise<LoadedRelease> => {
    const key = exactKey(identity(entry));
    const cached = cache.get(key);
    if (cached) return cached;
    const manifestBytes = Uint8Array.from(await documents.load(entry.manifest.url));
    if (await sha256(manifestBytes) !== entry.manifest.sha256) {
      throw new InstallFailure("RELEASE_VERIFICATION_FAILED", [
        `${entry.kind}:${entry.id}@${entry.version}: owner release manifest digest mismatch`,
      ]);
    }
    const parsed = parseReleaseManifest(parseJson(manifestBytes, entry.manifest.url));
    if (!parsed.ok) throw new InstallFailure("RELEASE_VERIFICATION_FAILED", parsed.errors);
    const release = parsed.value;
    if (release.kind !== entry.kind || release.id !== entry.id || release.version !== entry.version) {
      throw new InstallFailure("RELEASE_VERIFICATION_FAILED", [
        `${entry.kind}:${entry.id}@${entry.version}: registry identity differs from owner release`,
      ]);
    }
    if (!githubReleaseAssetBelongsTo(entry.manifest.url, release.source.repository, release.releaseTag)) {
      throw new InstallFailure("RELEASE_VERIFICATION_FAILED", [
        `${entry.kind}:${entry.id}@${entry.version}: owner release manifest URL is outside its source release`,
      ]);
    }
    const value = { entry, manifestBytes, release };
    cache.set(key, value);
    return value;
  };

  let selected = new Map<string, RegistryUnitIndexEntry>([[unitKey(rootEntry), rootEntry]]);
  const seen = new Set<string>();
  const limit = Math.max(4, certified.index.units.length * 2 + 2);
  for (let iteration = 0; iteration < limit; iteration += 1) {
    const signature = [...selected.values()]
      .map((entry) => `${exactKey(identity(entry))}`)
      .sort()
      .join("|");
    if (seen.has(signature)) {
      throw new InstallFailure("DEPENDENCY_RESOLUTION_FAILED", [
        "dependency constraints do not converge to one installable version per unit",
      ]);
    }
    seen.add(signature);

    const constraints = new Map<string, { kind: RegistryUnitIdentity["kind"]; id: string; ranges: string[] }>();
    constraints.set(unitKey(root), { kind: root.kind, id: root.id, ranges: [root.version] });
    const queue = [...selected.values()];
    const queued = new Set(queue.map(unitKey));
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      const envelope = await load(current);
      for (const dependency of envelope.release.dependencies) {
        const publicResolution = resolveRegistryDependency(certified, dependency);
        if (!publicResolution.ok) {
          throw new InstallFailure("DEPENDENCY_RESOLUTION_FAILED", publicResolution.errors);
        }
        const key = unitKey(dependency);
        const constraint = constraints.get(key) ?? {
          kind: dependency.kind,
          id: dependency.id,
          ranges: [],
        };
        // sidecar dependencies include no range — the index fixes the version, compatibility is the interface contract pin.
        if (dependency.range !== undefined) constraint.ranges.push(dependency.range);
        constraints.set(key, constraint);
        const provisional = selected.get(key) ?? publicResolution.value;
        if (!queued.has(key)) {
          queue.push(provisional);
          queued.add(key);
        }
      }
    }

    const next = new Map<string, RegistryUnitIndexEntry>();
    for (const [key, constraint] of constraints) {
      const candidates = certified.index.units
        .filter((entry) =>
          entry.kind === constraint.kind &&
          entry.id === constraint.id &&
          constraint.ranges.every((range) => semverSatisfies(entry.version, range) === true)
        )
        .sort((left, right) => -(semverCompare(left.version, right.version) ?? 0));
      if (candidates.length === 0) {
        throw new InstallFailure("DEPENDENCY_RESOLUTION_FAILED", [
          `${constraint.kind}:${constraint.id} has no version satisfying ${constraint.ranges.join(" AND ")}`,
        ]);
      }
      next.set(key, candidates[0]);
    }
    if (sameSelection(selected, next)) {
      for (const entry of next.values()) await load(entry);
      return { order: topologicalOrder(next, cache, root), loaded: cache };
    }
    selected = next;
  }
  throw new InstallFailure("DEPENDENCY_RESOLUTION_FAILED", [
    "dependency closure exceeded the finite convergence bound",
  ]);
}

async function downloadedReports(
  entry: RegistryUnitIndexEntry,
  documents: RegistryDocumentLoader,
): Promise<{ url: string; bytes: Uint8Array }[]> {
  return await Promise.all(entry.reports.map(async (reference) => ({
    url: reference.url,
    bytes: Uint8Array.from(await documents.load(reference.url)),
  })));
}

export async function installRegistryClosure(
  request: RegistryInstallRequest,
): Promise<RegistryInstallResult> {
  const root = { ...request.root };
  const registryId = request.certified.index.registryId;
  let transactionId: string | null = null;
  try {
    const closure = await solveClosure(request.certified, root, request.documents);
    const transaction = await request.artifacts.begin({ registryId, root });
    transactionId = transaction.transactionId;
    if (!transactionId) {
      throw new InstallFailure("ATOMIC_INSTALL_FAILED", ["native installer returned an empty transaction id"]);
    }
    const verifiedUnits: VerifiedInstallUnit[] = [];
    for (const entry of closure.order) {
      const envelope = closure.loaded.get(exactKey(identity(entry)));
      if (!envelope) {
        throw new InstallFailure("RELEASE_VERIFICATION_FAILED", [
          `missing loaded owner release for ${entry.kind}:${entry.id}@${entry.version}`,
        ]);
      }
      const artifact = selectArtifact(envelope.release, request.target);
      const staged = await request.artifacts.stage({
        transactionId,
        registryId,
        unit: identity(entry),
        artifact,
      });
      verifyStagingEvidence(staged, artifact);
      await verifyStagedPluginManifest(
        request.artifacts,
        transactionId,
        staged,
        envelope.release,
        artifact,
      );
      const reports = await downloadedReports(entry, request.documents);
      const certifiedRelease = await verifyRegistryUnitRelease(
        request.certified,
        identity(entry),
        envelope.manifestBytes,
        reports,
      );
      if (!certifiedRelease.ok) {
        throw new InstallFailure("RELEASE_VERIFICATION_FAILED", certifiedRelease.errors);
      }
      verifiedUnits.push(Object.freeze({
        ...identity(entry),
        registryId,
        sourceRepository: certifiedRelease.value.release.source.repository,
        sourceCommit: certifiedRelease.value.release.source.commit,
        releaseTag: certifiedRelease.value.release.releaseTag,
        artifactUrl: artifact.url,
        artifactSha256: artifact.sha256,
        stagedHandle: staged.handle,
      }));
    }
    const committed = await request.artifacts.commit(transactionId, verifiedUnits);
    transactionId = null;
    return {
      ok: true,
      registryId,
      generation: committed.generation,
      units: Object.freeze(verifiedUnits),
    };
  } catch (cause) {
    if (transactionId !== null) {
      try {
        await request.artifacts.rollback(transactionId);
      } catch {
        // The original fail-closed error remains authoritative. Native transaction
        // recovery must independently remove abandoned staging on process startup.
      }
    }
    if (cause instanceof InstallFailure) {
      return { ok: false, code: cause.code, errors: cause.errors };
    }
    return {
      ok: false,
      code: "ATOMIC_INSTALL_FAILED",
      errors: [cause instanceof Error ? cause.message : String(cause)],
    };
  }
}
