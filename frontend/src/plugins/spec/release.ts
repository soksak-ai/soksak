// Owner release manifest for one plugin, sidecar, or kit.
// artifact bytes and declarative entrypoints; a registry may only index it by URL+digest.
import {
  SIDECAR_CONTRACT_ID_RE,
  type ContractProviderRef,
  contractProviderKey,
  parseContractProviderRef,
} from "./contracts";
import {
  ANY_TARGET,
  GIT_COMMIT_RE,
  RELEASE_SPEC,
  SHA256_RE,
  RELEASE_ID_RE,
  githubReleaseAssetBelongsTo,
  isArtifactFormat,
  parseCanonicalGithubRepository,
  isNativeTarget,
  isSafeRelativeArtifactPath,
  isStrictSemver,
  isDependencyRange,
  isReleaseKind,
  releaseTagMatches,
  type ArtifactFormat,
  type ReleaseKind,
  type ArtifactTarget,
} from "./release-primitives";
import { checkKnownKeys, isRecord } from "./util";

export type PlatformParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export interface ReleaseSourceReference {
  repository: string;
  commit: string;
}

export interface ReleaseDependency {
  kind: ReleaseKind;
  id: string;
  /** Resolved only inside the originating registry. Cross-registry fallback is forbidden.
   *  plugin/kit dependencies declare the author's intended range. sidecar dependencies omit
   *  range — the signed index fixes the installed version and compatibility is the
   *  interface contract pin, so a release-version bound here would be invented information. */
  range?: string;
}

export interface NamedArtifactPath {
  name: string;
  path: string;
}

export interface PluginEntrypoint {
  kind: "plugin";
  manifest: string;
}

export interface SidecarEntrypoint {
  kind: "sidecar";
  interface: ContractProviderRef;
  process?: NamedArtifactPath[];
  library?: NamedArtifactPath[];
}

export interface KitEntrypoint {
  kind: "kit";
  packageManifest: string;
}

export type ReleaseEntrypoint = PluginEntrypoint | SidecarEntrypoint | KitEntrypoint;

export interface ReleaseArtifact {
  target: ArtifactTarget;
  url: string;
  size: number;
  sha256: string;
  format: ArtifactFormat;
  entrypoint: ReleaseEntrypoint;
}

export interface ReleaseManifest {
  spec: typeof RELEASE_SPEC;
  kind: ReleaseKind;
  id: string;
  version: string;
  source: ReleaseSourceReference;
  releaseTag: string;
  dependencies: ReleaseDependency[];
  artifacts: ReleaseArtifact[];
}

function strictObject(
  raw: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
  errors: string[],
): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    errors.push(`${label}: object required`);
    return null;
  }
  checkKnownKeys(raw, allowed, label, errors);
  for (const key of required) if (!(key in raw)) errors.push(`${label}.${key}: required`);
  return raw;
}

function sortedUnique(values: string[], label: string, errors: string[]): void {
  if (new Set(values).size !== values.length) errors.push(`${label}: duplicate entries forbidden`);
  const sorted = [...values].sort();
  if (values.some((value, index) => value !== sorted[index])) {
    errors.push(`${label}: entries must be sorted`);
  }
}

function parseSource(raw: unknown, errors: string[]): ReleaseSourceReference | null {
  const before = errors.length;
  const value = strictObject(raw, ["commit", "repository"], ["commit", "repository"], "release.source", errors);
  if (!value) return null;
  const repository = typeof value.repository === "string" ? value.repository : "";
  if (!parseCanonicalGithubRepository(repository)) {
    errors.push("release.source.repository: canonical GitHub repository URL required");
  }
  if (!GIT_COMMIT_RE.test(typeof value.commit === "string" ? value.commit : "")) {
    errors.push("release.source.commit: exact lowercase 40-character Git commit required");
  }
  if (errors.length !== before) return null;
  return { repository, commit: value.commit as string };
}

function parseDependencies(raw: unknown, owner: { kind: ReleaseKind; id: string }, errors: string[]): ReleaseDependency[] {
  const dependencies: ReleaseDependency[] = [];
  if (!Array.isArray(raw)) {
    errors.push("release.dependencies: array required");
    return dependencies;
  }
  raw.forEach((item, index) => {
    const label = `release.dependencies[${index}]`;
    const before = errors.length;
    const value = strictObject(item, ["id", "kind", "range"], ["id", "kind"], label, errors);
    if (!value) return;
    if (!isReleaseKind(value.kind)) errors.push(`${label}.kind: kit|plugin|sidecar required`);
    if (typeof value.id !== "string" || !RELEASE_ID_RE.test(value.id)) errors.push(`${label}.id: release id required`);
    // sidecar dependencies declare no range (version = index, compatibility = interface contract pin).
    // When present, validate syntax only — existing publications stay accepted.
    if (value.kind === "sidecar") {
      if (value.range !== undefined && !isDependencyRange(value.range)) {
        errors.push(`${label}.range: strict supported SemVer range required`);
      }
    } else if (!isDependencyRange(value.range)) {
      errors.push(`${label}.range: strict supported SemVer range required`);
    }
    if (value.kind === owner.kind && value.id === owner.id) errors.push(`${label}: self dependency forbidden`);
    if (errors.length === before) {
      dependencies.push({
        kind: value.kind as ReleaseKind,
        id: value.id as string,
        ...(value.range !== undefined ? { range: value.range as string } : {}),
      });
    }
  });
  sortedUnique(dependencies.map((dep) => `${dep.kind}\u0000${dep.id}`), "release.dependencies", errors);
  return dependencies;
}

function parseNamedPaths(raw: unknown, label: string, errors: string[]): NamedArtifactPath[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${label}: non-empty array required when declared`);
    return undefined;
  }
  const result: NamedArtifactPath[] = [];
  raw.forEach((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const before = errors.length;
    const value = strictObject(item, ["name", "path"], ["name", "path"], itemLabel, errors);
    if (!value) return;
    if (typeof value.name !== "string" || !RELEASE_ID_RE.test(value.name)) {
      errors.push(`${itemLabel}.name: flat entrypoint name required`);
    }
    if (!isSafeRelativeArtifactPath(value.path)) errors.push(`${itemLabel}.path: safe explicit relative path required`);
    if (errors.length === before) result.push({ name: value.name as string, path: value.path as string });
  });
  sortedUnique(result.map((item) => item.name), label, errors);
  return result;
}

function parseEntrypoint(raw: unknown, kind: ReleaseKind, label: string, errors: string[]): ReleaseEntrypoint | null {
  const before = errors.length;
  if (kind === "plugin") {
    const value = strictObject(raw, ["kind", "manifest"], ["kind", "manifest"], label, errors);
    if (!value) return null;
    if (value.kind !== "plugin") errors.push(`${label}.kind: plugin required`);
    if (!isSafeRelativeArtifactPath(value.manifest)) errors.push(`${label}.manifest: safe explicit relative path required`);
    return errors.length === before ? { kind: "plugin", manifest: value.manifest as string } : null;
  }
  if (kind === "kit") {
    const value = strictObject(raw, ["kind", "packageManifest"], ["kind", "packageManifest"], label, errors);
    if (!value) return null;
    if (value.kind !== "kit") errors.push(`${label}.kind: kit required`);
    if (!isSafeRelativeArtifactPath(value.packageManifest)) {
      errors.push(`${label}.packageManifest: safe explicit relative path required`);
    }
    return errors.length === before ? { kind: "kit", packageManifest: value.packageManifest as string } : null;
  }
  const value = strictObject(
    raw,
    ["interface", "kind", "library", "process"],
    ["interface", "kind"],
    label,
    errors,
  );
  if (!value) return null;
  if (value.kind !== "sidecar") errors.push(`${label}.kind: sidecar required`);
  const interfaceRef = parseContractProviderRef(
    value.interface,
    `${label}.interface`,
    errors,
    SIDECAR_CONTRACT_ID_RE,
  );
  const process = parseNamedPaths(value.process, `${label}.process`, errors);
  const library = parseNamedPaths(value.library, `${label}.library`, errors);
  if (!process && !library) errors.push(`${label}: at least one process or library path required`);
  const names = [...(process ?? []), ...(library ?? [])].map((item) => item.name);
  if (new Set(names).size !== names.length) errors.push(`${label}.entrypoint names: duplicate names forbidden`);
  if (errors.length !== before) return null;
  const result: SidecarEntrypoint = { kind: "sidecar", interface: interfaceRef! };
  if (process) result.process = process;
  if (library) result.library = library;
  return result;
}

function formatMatchesUrl(format: ArtifactFormat, url: string): boolean {
  if (format === "tar.gz") return url.endsWith(".tar.gz");
  return url.endsWith(".tgz");
}

function parseArtifacts(
  raw: unknown,
  owner: { kind: ReleaseKind; source: ReleaseSourceReference; releaseTag: string },
  errors: string[],
): ReleaseArtifact[] {
  const artifacts: ReleaseArtifact[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push("release.artifacts: non-empty array required");
    return artifacts;
  }
  raw.forEach((item, index) => {
    const label = `release.artifacts[${index}]`;
    const before = errors.length;
    const value = strictObject(
      item,
      ["entrypoint", "format", "sha256", "size", "target", "url"],
      ["entrypoint", "format", "sha256", "size", "target", "url"],
      label,
      errors,
    );
    if (!value) return;
    let target: ArtifactTarget | null = null;
    if (owner.kind === "sidecar") {
      if (!isNativeTarget(value.target)) errors.push(`${label}.target: canonical native target triple required`);
      else target = value.target;
    } else if (value.target !== ANY_TARGET) {
      errors.push(`${label}.target: ${owner.kind} releases require target any`);
    } else {
      target = ANY_TARGET;
    }
    if (typeof value.url !== "string" || !githubReleaseAssetBelongsTo(value.url, owner.source.repository, owner.releaseTag)) {
      errors.push(`${label}.url: canonical same-repository GitHub Release asset URL required`);
    }
    if (!SHA256_RE.test(typeof value.sha256 === "string" ? value.sha256 : "")) {
      errors.push(`${label}.sha256: exact lowercase SHA-256 required`);
    }
    if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0) errors.push(`${label}.size: positive safe integer required`);
    if (!isArtifactFormat(value.format)) errors.push(`${label}.format: tar.gz|tgz required`);
    if (isArtifactFormat(value.format) && typeof value.url === "string" && !formatMatchesUrl(value.format, value.url)) {
      errors.push(`${label}.format: must match release asset suffix`);
    }
    const entrypoint = parseEntrypoint(value.entrypoint, owner.kind, `${label}.entrypoint`, errors);
    if (errors.length === before && target && entrypoint) {
      artifacts.push({
        target,
        url: value.url as string,
        size: value.size as number,
        sha256: value.sha256 as string,
        format: value.format as ArtifactFormat,
        entrypoint,
      });
    }
  });
  sortedUnique(artifacts.map((artifact) => artifact.target), "release.artifacts.target", errors);
  if (owner.kind === "sidecar") {
    const interfaces = artifacts.map((artifact) =>
      artifact.entrypoint.kind === "sidecar" ? contractProviderKey(artifact.entrypoint.interface) : "",
    );
    if (new Set(interfaces).size !== 1) {
      errors.push("release.artifacts: every sidecar target must expose the same interface");
    }
  }
  if (owner.kind !== "sidecar" && artifacts.length !== 1) {
    errors.push(`release.artifacts: ${owner.kind} release requires exactly one any artifact`);
  }
  return artifacts;
}

export function parseReleaseManifest(raw: unknown): PlatformParseResult<ReleaseManifest> {
  const errors: string[] = [];
  const value = strictObject(
    raw,
    ["artifacts", "dependencies", "id", "kind", "releaseTag", "source", "spec", "version"],
    ["artifacts", "dependencies", "id", "kind", "releaseTag", "source", "spec", "version"],
    "release",
    errors,
  );
  if (!value) return { ok: false, errors };
  if (value.spec !== RELEASE_SPEC) errors.push(`release.spec: ${RELEASE_SPEC} required`);
  if (!isReleaseKind(value.kind)) errors.push("release.kind: kit|plugin|sidecar required");
  if (typeof value.id !== "string" || !RELEASE_ID_RE.test(value.id)) errors.push("release.id: release id required");
  if (!isStrictSemver(value.version)) errors.push("release.version: strict semantic version required");
  if (
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    !releaseTagMatches(value.id, value.version, value.releaseTag)
  ) {
    errors.push("release.releaseTag: v<version> or <release-id>-v<version> required");
  }
  const source = parseSource(value.source, errors);
  const kind = isReleaseKind(value.kind) ? value.kind : null;
  const id = typeof value.id === "string" ? value.id : "";
  const releaseTag = typeof value.releaseTag === "string" ? value.releaseTag : "";
  const dependencies = kind ? parseDependencies(value.dependencies, { kind, id }, errors) : [];
  const artifacts = kind && source
    ? parseArtifacts(value.artifacts, { kind, source, releaseTag }, errors)
    : [];
  if (errors.length > 0 || !kind || !source) return { ok: false, errors };
  return {
    ok: true,
    value: {
      spec: value.spec as typeof RELEASE_SPEC,
      kind,
      id,
      version: value.version as string,
      source,
      releaseTag,
      dependencies,
      artifacts,
    },
  };
}

export type PluginDependencyProjectionResult =
  | { ok: true }
  | { ok: false; errors: string[] };

// plugin.json.dependencies is the runtime authorization relationship. The owner
// release manifest is the only install closure. Equality prevents either boundary
// from silently granting or installing a plugin relationship the other did not name.
export function verifyPluginRuntimeDependencyProjection(
  runtimeDependencies: Readonly<Record<string, string>> | undefined,
  release: ReleaseManifest,
): PluginDependencyProjectionResult {
  if (release.kind !== "plugin") {
    return { ok: false, errors: ["runtime plugin dependencies require a plugin owner release"] };
  }
  const runtime = Object.entries(runtimeDependencies ?? {})
    .map(([id, range]) => ({ kind: "plugin" as const, id, range }))
    .sort((left, right) => left.id === right.id ? 0 : left.id < right.id ? -1 : 1);
  const install = release.dependencies
    .filter((dependency) => dependency.kind === "plugin")
    .sort((left, right) => left.id === right.id ? 0 : left.id < right.id ? -1 : 1);
  if (JSON.stringify(runtime) !== JSON.stringify(install)) {
    return {
      ok: false,
      errors: [
        "plugin runtime dependencies must exactly equal release plugin dependencies; sidecar/kit closure remains release-only",
      ],
    };
  }
  return { ok: true };
}
