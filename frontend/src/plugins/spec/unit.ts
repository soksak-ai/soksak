// Public platform-unit primitives. Plugin, sidecar, kit, release, conformance and
// registry contracts import these exact values; no boundary may restate their grammar.

export {
  MAX_SEMVER_LENGTH,
  MAX_UNIT_DEPENDENCY_CLAUSES,
  MAX_UNIT_DEPENDENCY_RANGE_LENGTH,
  STRICT_SEMVER_PATTERN,
  STRICT_SEMVER_RE,
  isStrictSemver,
  isUnitDependencyRange,
} from "./semver";

export const UNIT_KINDS = ["kit", "plugin", "sidecar"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

// Unit identity is flat because registry identity is already qualified separately.
// A third-party author does not need a soksak prefix.
export const UNIT_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

export const SHA256_RE = /^[a-f0-9]{64}$/;
export const GIT_COMMIT_RE = /^[a-f0-9]{40}$/;

export const ANY_TARGET = "any" as const;
export const NATIVE_TARGETS = [
  "aarch64-apple-darwin",
  "aarch64-pc-windows-msvc",
  "aarch64-unknown-linux-gnu",
  "aarch64-unknown-linux-musl",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
] as const;
export const UNIT_TARGETS = [ANY_TARGET, ...NATIVE_TARGETS] as const;
export type NativeTarget = (typeof NATIVE_TARGETS)[number];
export type UnitTarget = (typeof UNIT_TARGETS)[number];

// The 0.0.1 baseline enacts one archive format (gzip-compressed POSIX tar) with two conventional
// filename suffixes. ZIP remains invalid until its extractor enforces the same
// regular-file, portable-path, collision, and size invariants.
export const ARTIFACT_FORMATS = ["tar.gz", "tgz"] as const;
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

// The core's spec version, stamped into every envelope the core defines — the runtime transport and
// nothing else. For a document the core reads, the stamp is the publisher's, below.
export const CORE_SPEC = "0.0.1" as const;
export type CoreSpec = typeof CORE_SPEC;

// The stamps on the four documents the core reads and does not publish.
//
// These were folded into CORE_SPEC on 2026-08-16, on the reasoning that a field's place already
// identifies its document. On the wire it does not: a release manifest is fetched alone by URL, and
// `spec` is its only identification. Measured the same day against what is served — the index, a
// release manifest, both conformance reports and a packaged plugin manifest all stamped with the
// names below — so the fold made 54 published units unreadable at four layers at once.
//
// A per-plugin format — `soksak-spec-plugin-terminal` — was an invention and stays deleted. These
// four are formats, one per document kind, and the publisher owns each.
export const RELEASE_SPEC = "soksak-spec-release@0.0.1" as const;
export const REGISTRY_SPEC = "soksak-spec-registry@0.0.1" as const;
export const CONFORMANCE_REPORT_SPEC = "soksak-spec-conformance@0.0.1" as const;
export const UNIT_SPEC_BY_KIND = {
  kit: "soksak-spec-kit@0.0.1",
  plugin: "soksak-spec-plugin@0.0.1",
  sidecar: "soksak-spec-sidecar@0.0.1",
} as const satisfies Record<UnitKind, string>;

export function isUnitKind(value: unknown): value is UnitKind {
  return typeof value === "string" && (UNIT_KINDS as readonly string[]).includes(value);
}

export function isUnitTarget(value: unknown): value is UnitTarget {
  return typeof value === "string" && (UNIT_TARGETS as readonly string[]).includes(value);
}

export function isNativeTarget(value: unknown): value is NativeTarget {
  return typeof value === "string" && (NATIVE_TARGETS as readonly string[]).includes(value);
}

export function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return typeof value === "string" && (ARTIFACT_FORMATS as readonly string[]).includes(value);
}

export const PORTABLE_ARCHIVE_PATH_MAX_BYTES = 512;
export const PORTABLE_ARCHIVE_SEGMENT_MAX_BYTES = 255;

function isWindowsReservedPathSegment(segment: string): boolean {
  const stem = segment.split(".", 1)[0].toUpperCase();
  return ["CON", "PRN", "AUX", "NUL"].includes(stem) || /^(?:COM|LPT)[1-9]$/.test(stem);
}

export function isSafeRelativeUnitPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PORTABLE_ARCHIVE_PATH_MAX_BYTES ||
    value.startsWith("/") ||
    !/^[\x20-\x7e]+$/.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) =>
    part !== "" &&
    part !== "." &&
    part !== ".." &&
    part.length <= PORTABLE_ARCHIVE_SEGMENT_MAX_BYTES &&
    !part.endsWith(" ") &&
    !part.endsWith(".") &&
    !/[<>:"\\|?*]/.test(part) &&
    !isWindowsReservedPathSegment(part)
  );
}

export interface GithubRepositoryParts {
  owner: string;
  repository: string;
}

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RELEASE_ASSET_RE = /^[a-z0-9][a-z0-9._-]{0,254}$/;

export function parseCanonicalGithubRepository(value: unknown): GithubRepositoryParts | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.toString() !== value
    ) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      parts.length !== 2 ||
      url.pathname !== `/${parts[0]}/${parts[1]}` ||
      !GITHUB_OWNER_RE.test(parts[0]) ||
      !GITHUB_REPOSITORY_RE.test(parts[1]) ||
      parts[1].endsWith(".git")
    ) {
      return null;
    }
    return { owner: parts[0], repository: parts[1] };
  } catch {
    return null;
  }
}

export interface GithubReleaseAssetParts extends GithubRepositoryParts {
  releaseTag: string;
  asset: string;
}

// Kept separate from URL parsing so release.ts can bind owner/repository/tag to the
// parsed owner manifest instead of treating a URL as self-authenticating.
export function parseCanonicalGithubReleaseAssetUrl(value: unknown): GithubReleaseAssetParts | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.toString() !== value
    ) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 6 || parts[2] !== "releases" || parts[3] !== "download") return null;
    const owner = parts[0];
    const repository = parts[1];
    const releaseTag = decodeURIComponent(parts[4]);
    const asset = decodeURIComponent(parts[5]);
    if (
      parts[4] !== releaseTag ||
      parts[5] !== asset ||
      url.pathname !== `/${owner}/${repository}/releases/download/${releaseTag}/${asset}` ||
      !GITHUB_OWNER_RE.test(owner) ||
      !GITHUB_REPOSITORY_RE.test(repository) ||
      repository.endsWith(".git") ||
      releaseTag.length === 0 ||
      !RELEASE_ASSET_RE.test(asset)
    ) {
      return null;
    }
    return { owner, repository, releaseTag, asset };
  } catch {
    return null;
  }
}

export function releaseTagForUnit(id: string, version: string, tag: unknown): tag is string {
  return typeof tag === "string" && (tag === `v${version}` || tag === `${id}-v${version}`);
}

export function githubReleaseAssetBelongsTo(
  url: unknown,
  repository: string,
  releaseTag: string,
): boolean {
  const source = parseCanonicalGithubRepository(repository);
  const asset = parseCanonicalGithubReleaseAssetUrl(url);
  return !!source && !!asset &&
    source.owner === asset.owner &&
    source.repository === asset.repository &&
    asset.releaseTag === releaseTag;
}
