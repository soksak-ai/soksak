// Unit-owner release manifest. This envelope owns install identity, dependency closure,
// artifact bytes and declarative entrypoints; a registry may only index it by URL+digest.
import {
  SIDECAR_CONTRACT_ID_RE,
  type ContractProviderRef,
  contractProviderKey,
  parseContractProviderRef,
} from "./contracts.js";
import {
  ANY_TARGET,
  GIT_COMMIT_RE,
  RELEASE_SPEC,
  SHA256_RE,
  UNIT_ID_RE,
  githubReleaseAssetBelongsTo,
  isArtifactFormat,
  parseCanonicalGithubRepository,
  isRustSidecarTarget,
  isSafeRelativeUnitPath,
  isStrictSemver,
  isUnitDependencyRange,
  isUnitKind,
  releaseTagForUnit,
  type ArtifactFormat,
  type RustSidecarTarget,
  type UnitKind,
  type UnitTarget,
} from "./unit.js";
import { checkKnownKeys, isRecord } from "./util.js";

export type PlatformParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export interface UnitSourceReference {
  repository: string;
  commit: string;
}

export interface UnitDependency {
  kind: UnitKind;
  id: string;
  /** Resolved only inside the originating registry. Cross-registry fallback is forbidden.
   *  plugin/kit dependencies declare the author's intended range. sidecar dependencies omit
   *  range — the signed index decides the installed version and compatibility belongs to the
   *  interface contract pin, so a unit-version bound here would be invented information. */
  range?: string;
}

export interface NamedUnitPath {
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
  process?: NamedUnitPath[];
  library?: NamedUnitPath[];
}

export interface KitEntrypoint {
  kind: "kit";
  packageManifest: string;
}

export type UnitEntrypoint = PluginEntrypoint | SidecarEntrypoint | KitEntrypoint;

export interface UnitReleaseArtifact {
  target: UnitTarget;
  url: string;
  sha256: string;
  format: ArtifactFormat;
  entrypoint: UnitEntrypoint;
}

export interface UnitReleaseManifest {
  spec: typeof RELEASE_SPEC;
  kind: UnitKind;
  id: string;
  version: string;
  source: UnitSourceReference;
  releaseTag: string;
  dependencies: UnitDependency[];
  artifacts: UnitReleaseArtifact[];
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

function parseSource(raw: unknown, errors: string[]): UnitSourceReference | null {
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

function parseDependencies(raw: unknown, owner: { kind: UnitKind; id: string }, errors: string[]): UnitDependency[] {
  const dependencies: UnitDependency[] = [];
  if (!Array.isArray(raw)) {
    errors.push("release.dependencies: array required");
    return dependencies;
  }
  raw.forEach((item, index) => {
    const label = `release.dependencies[${index}]`;
    const before = errors.length;
    const value = strictObject(item, ["id", "kind", "range"], ["id", "kind"], label, errors);
    if (!value) return;
    if (!isUnitKind(value.kind)) errors.push(`${label}.kind: kit|plugin|sidecar required`);
    if (typeof value.id !== "string" || !UNIT_ID_RE.test(value.id)) errors.push(`${label}.id: flat unit id required`);
    // sidecar 의존은 range 를 선언하지 않는다(버전=인덱스, 호환성=interface 계약-핀). 있으면 문법만 검증(기존 발행물 수용).
    if (value.kind === "sidecar") {
      if (value.range !== undefined && !isUnitDependencyRange(value.range)) {
        errors.push(`${label}.range: strict supported SemVer range required`);
      }
    } else if (!isUnitDependencyRange(value.range)) {
      errors.push(`${label}.range: strict supported SemVer range required`);
    }
    if (value.kind === owner.kind && value.id === owner.id) errors.push(`${label}: self dependency forbidden`);
    if (errors.length === before) {
      dependencies.push({
        kind: value.kind as UnitKind,
        id: value.id as string,
        ...(value.range !== undefined ? { range: value.range as string } : {}),
      });
    }
  });
  sortedUnique(dependencies.map((dep) => `${dep.kind}\u0000${dep.id}`), "release.dependencies", errors);
  return dependencies;
}

function parseNamedPaths(raw: unknown, label: string, errors: string[]): NamedUnitPath[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${label}: non-empty array required when declared`);
    return undefined;
  }
  const result: NamedUnitPath[] = [];
  raw.forEach((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const before = errors.length;
    const value = strictObject(item, ["name", "path"], ["name", "path"], itemLabel, errors);
    if (!value) return;
    if (typeof value.name !== "string" || !UNIT_ID_RE.test(value.name)) {
      errors.push(`${itemLabel}.name: flat entrypoint name required`);
    }
    if (!isSafeRelativeUnitPath(value.path)) errors.push(`${itemLabel}.path: safe explicit relative path required`);
    if (errors.length === before) result.push({ name: value.name as string, path: value.path as string });
  });
  sortedUnique(result.map((item) => item.name), label, errors);
  return result;
}

function parseEntrypoint(raw: unknown, kind: UnitKind, label: string, errors: string[]): UnitEntrypoint | null {
  const before = errors.length;
  if (kind === "plugin") {
    const value = strictObject(raw, ["kind", "manifest"], ["kind", "manifest"], label, errors);
    if (!value) return null;
    if (value.kind !== "plugin") errors.push(`${label}.kind: plugin required`);
    if (!isSafeRelativeUnitPath(value.manifest)) errors.push(`${label}.manifest: safe explicit relative path required`);
    return errors.length === before ? { kind: "plugin", manifest: value.manifest as string } : null;
  }
  if (kind === "kit") {
    const value = strictObject(raw, ["kind", "packageManifest"], ["kind", "packageManifest"], label, errors);
    if (!value) return null;
    if (value.kind !== "kit") errors.push(`${label}.kind: kit required`);
    if (!isSafeRelativeUnitPath(value.packageManifest)) {
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
  owner: { kind: UnitKind; source: UnitSourceReference; releaseTag: string },
  errors: string[],
): UnitReleaseArtifact[] {
  const artifacts: UnitReleaseArtifact[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push("release.artifacts: non-empty array required");
    return artifacts;
  }
  raw.forEach((item, index) => {
    const label = `release.artifacts[${index}]`;
    const before = errors.length;
    const value = strictObject(
      item,
      ["entrypoint", "format", "sha256", "target", "url"],
      ["entrypoint", "format", "sha256", "target", "url"],
      label,
      errors,
    );
    if (!value) return;
    let target: UnitTarget | null = null;
    if (owner.kind === "sidecar") {
      if (!isRustSidecarTarget(value.target)) errors.push(`${label}.target: canonical Rust sidecar target required`);
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
    if (!isArtifactFormat(value.format)) errors.push(`${label}.format: tar.gz|tgz required`);
    if (isArtifactFormat(value.format) && typeof value.url === "string" && !formatMatchesUrl(value.format, value.url)) {
      errors.push(`${label}.format: must match release asset suffix`);
    }
    const entrypoint = parseEntrypoint(value.entrypoint, owner.kind, `${label}.entrypoint`, errors);
    if (errors.length === before && target && entrypoint) {
      artifacts.push({
        target,
        url: value.url as string,
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

export function parseReleaseManifest(raw: unknown): PlatformParseResult<UnitReleaseManifest> {
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
  if (!isUnitKind(value.kind)) errors.push("release.kind: kit|plugin|sidecar required");
  if (typeof value.id !== "string" || !UNIT_ID_RE.test(value.id)) errors.push("release.id: flat unit id required");
  if (!isStrictSemver(value.version)) errors.push("release.version: strict semantic version required");
  if (
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    !releaseTagForUnit(value.id, value.version, value.releaseTag)
  ) {
    errors.push("release.releaseTag: v<version> or <unit-id>-v<version> required");
  }
  const source = parseSource(value.source, errors);
  const kind = isUnitKind(value.kind) ? value.kind : null;
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
      spec: RELEASE_SPEC,
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
  release: UnitReleaseManifest,
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
