// Signed installation index. The registry owns discovery and trust continuity only;
// each unit's release manifest owns source, dependencies, artifacts and entrypoints.
import {
  conformanceContractKey,
  parseConformanceReport,
  requiredConformanceContracts,
  verifyConformanceReport,
  type ConformanceReport,
} from "./conformanceWire.js";
import {
  parseReleaseManifest,
  type PlatformParseResult,
  type UnitDependency,
  type UnitReleaseManifest,
} from "./release.js";
import { semverCompare, semverSatisfies } from "./semver.js";
import {
  REGISTRY_SPEC,
  SHA256_RE,
  UNIT_ID_RE,
  githubReleaseAssetBelongsTo,
  isStrictSemver,
  isUnitDependencyRange,
  isUnitKind,
  parseCanonicalGithubReleaseAssetUrl,
  type UnitKind,
} from "./unit.js";
import { checkKnownKeys, isRecord } from "./util.js";
import type { ContractProviderRef } from "./contracts.js";

export const REGISTRY_WIRE_SPEC = REGISTRY_SPEC;

export interface RegistryIntegrityReference {
  url: string;
  sha256: string;
}

export interface RegistryUnitIndexEntry {
  kind: UnitKind;
  id: string;
  version: string;
  manifest: RegistryIntegrityReference;
  reports: RegistryIntegrityReference[];
}

export interface RegistryPayload {
  spec: typeof REGISTRY_WIRE_SPEC;
  registryId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  units: RegistryUnitIndexEntry[];
}

export interface RegistrySignature {
  algorithm: "ed25519";
  keyId: string;
  value: string;
}

export interface RegistryPublicKey {
  algorithm: "ed25519";
  keyId: string;
  value: string;
}

export interface SignedRegistryIndex extends RegistryPayload {
  signature: RegistrySignature;
}

const REGISTRY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_SECONDS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

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
    errors.push(`${label}: entries must be sorted for deterministic signing`);
  }
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_SECONDS_RE.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString().replace(".000Z", "Z") === value;
}

function canonicalBase64Bytes(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  try {
    const decoded = atob(value);
    return decoded.length === bytes && btoa(decoded) === value;
  } catch {
    return false;
  }
}

function parseIntegrityReference(
  raw: unknown,
  label: string,
  errors: string[],
): RegistryIntegrityReference | null {
  const before = errors.length;
  const value = strictObject(raw, ["sha256", "url"], ["sha256", "url"], label, errors);
  if (!value) return null;
  if (!SHA256_RE.test(typeof value.sha256 === "string" ? value.sha256 : "")) {
    errors.push(`${label}.sha256: exact lowercase SHA-256 required`);
  }
  if (!parseCanonicalGithubReleaseAssetUrl(value.url)) {
    errors.push(`${label}.url: canonical GitHub Release asset URL required`);
  }
  return errors.length === before
    ? { url: value.url as string, sha256: value.sha256 as string }
    : null;
}

function parseUnit(raw: unknown, index: number, errors: string[]): RegistryUnitIndexEntry | null {
  const label = `registry.units[${index}]`;
  const before = errors.length;
  const value = strictObject(
    raw,
    ["id", "kind", "manifest", "reports", "version"],
    ["id", "kind", "manifest", "reports", "version"],
    label,
    errors,
  );
  if (!value) return null;
  if (!isUnitKind(value.kind)) errors.push(`${label}.kind: kit|plugin|sidecar required`);
  if (typeof value.id !== "string" || !UNIT_ID_RE.test(value.id)) errors.push(`${label}.id: flat unit id required`);
  if (!isStrictSemver(value.version)) errors.push(`${label}.version: strict semantic version required`);
  const manifest = parseIntegrityReference(value.manifest, `${label}.manifest`, errors);
  const reports: RegistryIntegrityReference[] = [];
  if (!Array.isArray(value.reports) || value.reports.length === 0) {
    errors.push(`${label}.reports: non-empty array required`);
  } else {
    value.reports.forEach((item, reportIndex) => {
      const report = parseIntegrityReference(item, `${label}.reports[${reportIndex}]`, errors);
      if (report) reports.push(report);
    });
    sortedUnique(reports.map((report) => report.url), `${label}.reports`, errors);
  }
  if (errors.length !== before || !manifest) return null;
  return {
    kind: value.kind as UnitKind,
    id: value.id as string,
    version: value.version as string,
    manifest,
    reports,
  };
}

export function parseRegistryPayload(raw: unknown): PlatformParseResult<RegistryPayload> {
  const errors: string[] = [];
  const value = strictObject(
    raw,
    ["expiresAt", "issuedAt", "registryId", "sequence", "spec", "units"],
    ["expiresAt", "issuedAt", "registryId", "sequence", "spec", "units"],
    "registry",
    errors,
  );
  if (!value) return { ok: false, errors };
  if (value.spec !== REGISTRY_WIRE_SPEC) errors.push(`registry.spec: ${REGISTRY_WIRE_SPEC} required`);
  if (typeof value.registryId !== "string" || !REGISTRY_ID_RE.test(value.registryId)) {
    errors.push("registry.registryId: lowercase registry id required");
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) {
    errors.push("registry.sequence: positive safe integer required");
  }
  if (!validTimestamp(value.issuedAt)) errors.push("registry.issuedAt: canonical UTC whole-second timestamp required");
  if (!validTimestamp(value.expiresAt)) errors.push("registry.expiresAt: canonical UTC whole-second timestamp required");
  if (
    validTimestamp(value.issuedAt) &&
    validTimestamp(value.expiresAt) &&
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
  ) {
    errors.push("registry.expiresAt: must be later than issuedAt");
  }
  const units: RegistryUnitIndexEntry[] = [];
  if (!Array.isArray(value.units)) {
    errors.push("registry.units: array required");
  } else {
    value.units.forEach((item, index) => {
      const unit = parseUnit(item, index, errors);
      if (unit) units.push(unit);
    });
    sortedUnique(
      units.map((unit) => `${unit.kind}\u0000${unit.id}\u0000${unit.version}`),
      "registry.units",
      errors,
    );
    const precedenceKeys = new Map<string, string>();
    for (const unit of units) {
      const precedence = unit.version.split("+", 1)[0];
      const key = `${unit.kind}\u0000${unit.id}\u0000${precedence}`;
      const existing = precedenceKeys.get(key);
      if (existing !== undefined && existing !== unit.version) {
        errors.push(`registry.units: ${unit.kind}:${unit.id} has ambiguous SemVer-equivalent versions`);
      } else {
        precedenceKeys.set(key, unit.version);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      spec: REGISTRY_WIRE_SPEC,
      registryId: value.registryId as string,
      sequence: value.sequence as number,
      issuedAt: value.issuedAt as string,
      expiresAt: value.expiresAt as string,
      units,
    },
  };
}

export function parseRegistrySignature(raw: unknown): PlatformParseResult<RegistrySignature> {
  const errors: string[] = [];
  const value = strictObject(
    raw,
    ["algorithm", "keyId", "value"],
    ["algorithm", "keyId", "value"],
    "registry.signature",
    errors,
  );
  if (!value) return { ok: false, errors };
  if (value.algorithm !== "ed25519") errors.push("registry.signature.algorithm: ed25519 required");
  if (typeof value.keyId !== "string" || !KEY_ID_RE.test(value.keyId)) {
    errors.push("registry.signature.keyId: invalid key id");
  }
  if (!canonicalBase64Bytes(value.value, 64)) {
    errors.push("registry.signature.value: canonical base64 Ed25519 64-byte signature required");
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { algorithm: "ed25519", keyId: value.keyId as string, value: value.value as string } };
}

export function parseRegistryPublicKey(raw: unknown): PlatformParseResult<RegistryPublicKey> {
  const errors: string[] = [];
  const value = strictObject(
    raw,
    ["algorithm", "keyId", "value"],
    ["algorithm", "keyId", "value"],
    "registry.publicKey",
    errors,
  );
  if (!value) return { ok: false, errors };
  if (value.algorithm !== "ed25519") errors.push("registry.publicKey.algorithm: ed25519 required");
  if (typeof value.keyId !== "string" || !KEY_ID_RE.test(value.keyId)) {
    errors.push("registry.publicKey.keyId: invalid key id");
  }
  if (!canonicalBase64Bytes(value.value, 32)) {
    errors.push("registry.publicKey.value: canonical base64 Ed25519 32-byte public key required");
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { algorithm: "ed25519", keyId: value.keyId as string, value: value.value as string } };
}

export function parseSignedRegistryIndex(raw: unknown): PlatformParseResult<SignedRegistryIndex> {
  const errors: string[] = [];
  const value = strictObject(
    raw,
    ["expiresAt", "issuedAt", "registryId", "sequence", "signature", "spec", "units"],
    ["expiresAt", "issuedAt", "registryId", "sequence", "signature", "spec", "units"],
    "registry",
    errors,
  );
  if (!value) return { ok: false, errors };
  const payload = parseRegistryPayload({
    expiresAt: value.expiresAt,
    issuedAt: value.issuedAt,
    registryId: value.registryId,
    sequence: value.sequence,
    spec: value.spec,
    units: value.units,
  });
  const signature = parseRegistrySignature(value.signature);
  if (!payload.ok) errors.push(...payload.errors);
  if (!signature.ok) errors.push(...signature.errors);
  return errors.length > 0 || !payload.ok || !signature.ok
    ? { ok: false, errors }
    : { ok: true, value: { ...payload.value, signature: signature.value } };
}

// RFC 8785 JCS over the normalized registry payload. The schema restricts keys and
// values to the JCS-safe subset (ASCII keys, safe integers, no floating point).
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("registry canonical payload contains a non-JSON value");
}

export function canonicalRegistryPayload(raw: unknown): Uint8Array {
  const parsed = isRecord(raw) && "signature" in raw
    ? parseSignedRegistryIndex(raw)
    : parseRegistryPayload(raw);
  if (!parsed.ok) throw new Error(`invalid registry payload: ${parsed.errors.join("; ")}`);
  const value = parsed.value;
  const payload: RegistryPayload = {
    spec: value.spec,
    registryId: value.registryId,
    sequence: value.sequence,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    units: value.units,
  };
  return new TextEncoder().encode(canonicalJson(payload));
}

function base64Bytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyEd25519(payload: Uint8Array, signature: string, key: RegistryPublicKey): Promise<boolean> {
  try {
    const imported = await crypto.subtle.importKey(
      "raw",
      base64Bytes(key.value),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      imported,
      base64Bytes(signature),
      payload,
    );
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export interface RegistryHighWater {
  sequence: number;
  digest: string;
}

export interface RegistryTrustPolicy {
  expectedRegistryId: string;
  expectedKeyId: string;
  publicKey: RegistryPublicKey;
  now: number;
  highWater?: RegistryHighWater;
}

declare const CERTIFIED_REGISTRY: unique symbol;
export type RegistryContinuity = "initial" | "unchanged" | "advance";
export interface CertifiedRegistryIndex {
  readonly index: SignedRegistryIndex;
  readonly digest: string;
  readonly continuity: RegistryContinuity;
  readonly highWater: RegistryHighWater;
  readonly [CERTIFIED_REGISTRY]: true;
}

// A TypeScript brand disappears at runtime. Trusted install operations therefore
// also require module-issued object identity; structurally similar plugin input is
// never accepted as certification evidence.
const certifiedRegistryIndexes = new WeakSet<object>();

export type RegistryCertificationCode =
  | "INVALID_INDEX"
  | "TRUST_MISMATCH"
  | "INVALID_SIGNATURE"
  | "NOT_CURRENT"
  | "INVALID_HIGH_WATER"
  | "ROLLBACK"
  | "EQUIVOCATION";

export type RegistryCertificationResult =
  | { ok: true; value: CertifiedRegistryIndex }
  | { ok: false; code: RegistryCertificationCode; errors: string[] };

function certificationFailure(code: RegistryCertificationCode, ...errors: string[]): RegistryCertificationResult {
  return { ok: false, code, errors };
}

export async function certifyRegistryIndex(
  raw: unknown,
  policy: RegistryTrustPolicy,
): Promise<RegistryCertificationResult> {
  // Trust policy is caller-owned mutable input. Capture every decision value before
  // the first asynchronous crypto boundary so a concurrent caller cannot change
  // identity, time, or rollback state after signature verification has started.
  const expectedRegistryId = policy.expectedRegistryId;
  const expectedKeyId = policy.expectedKeyId;
  const now = policy.now;
  const highWater = policy.highWater === undefined
    ? undefined
    : { sequence: policy.highWater.sequence, digest: policy.highWater.digest };
  const parsed = parseSignedRegistryIndex(raw);
  if (!parsed.ok) return certificationFailure("INVALID_INDEX", ...parsed.errors);
  const key = parseRegistryPublicKey(policy.publicKey);
  if (!key.ok) return certificationFailure("TRUST_MISMATCH", ...key.errors);
  const index = parsed.value;
  if (
    !REGISTRY_ID_RE.test(expectedRegistryId) ||
    index.registryId !== expectedRegistryId ||
    expectedKeyId !== key.value.keyId ||
    index.signature.keyId !== expectedKeyId
  ) {
    return certificationFailure("TRUST_MISMATCH", "registry identity or pinned key id mismatch");
  }
  const payload = canonicalRegistryPayload(index);
  if (!await verifyEd25519(payload, index.signature.value, key.value)) {
    return certificationFailure("INVALID_SIGNATURE", "Ed25519 signature verification failed");
  }
  if (
    !Number.isFinite(now) ||
    now < Date.parse(index.issuedAt) ||
    now >= Date.parse(index.expiresAt)
  ) {
    return certificationFailure("NOT_CURRENT", "registry index is not current at the supplied time");
  }
  const digest = await digestHex(payload);
  let continuity: RegistryContinuity = "initial";
  if (highWater !== undefined) {
    if (
      !Number.isSafeInteger(highWater.sequence) ||
      highWater.sequence < 1 ||
      !SHA256_RE.test(highWater.digest)
    ) {
      return certificationFailure("INVALID_HIGH_WATER", "invalid registry high-water state");
    }
    if (index.sequence < highWater.sequence) {
      return certificationFailure("ROLLBACK", "registry sequence rollback detected");
    }
    if (index.sequence === highWater.sequence) {
      if (digest !== highWater.digest) {
        return certificationFailure("EQUIVOCATION", "same registry sequence has different canonical bytes");
      }
      continuity = "unchanged";
    } else {
      continuity = "advance";
    }
  }
  const certified = deepFreeze({
    index,
    digest,
    continuity,
    highWater: { sequence: index.sequence, digest },
  }) as CertifiedRegistryIndex;
  certifiedRegistryIndexes.add(certified as object);
  return { ok: true, value: certified };
}

export interface RegistryUnitIdentity {
  kind: UnitKind;
  id: string;
  version: string;
}

export type RegistryDependencyResolutionResult =
  | { ok: true; value: RegistryUnitIndexEntry }
  | { ok: false; errors: string[] };

// A dependency is resolved against exactly the CertifiedRegistryIndex that supplied
// its parent. Calling code must never retry another registry after this returns false.
export function resolveRegistryDependency(
  certified: CertifiedRegistryIndex,
  dependency: UnitDependency,
): RegistryDependencyResolutionResult {
  if (!certifiedRegistryIndexes.has(certified as object)) {
    return { ok: false, errors: ["uncertified registry index"] };
  }
  if (
    !isUnitKind(dependency.kind) ||
    typeof dependency.id !== "string" ||
    !UNIT_ID_RE.test(dependency.id) ||
    !isUnitDependencyRange(dependency.range)
  ) {
    return { ok: false, errors: ["invalid unit dependency"] };
  }
  const candidates = certified.index.units
    .filter((entry) =>
      entry.kind === dependency.kind &&
      entry.id === dependency.id &&
      semverSatisfies(entry.version, dependency.range) === true
    )
    .sort((left, right) => -(semverCompare(left.version, right.version) ?? 0));
  if (candidates.length === 0) {
    return {
      ok: false,
      errors: [
        `${dependency.kind}:${dependency.id}@${dependency.range} is absent from origin registry ${certified.index.registryId}`,
      ],
    };
  }
  return { ok: true, value: candidates[0] };
}

export interface DownloadedRegistryDocument {
  url: string;
  bytes: Uint8Array;
}

declare const CERTIFIED_UNIT_RELEASE: unique symbol;
export interface CertifiedRegistryUnitRelease {
  readonly registryId: string;
  readonly entry: RegistryUnitIndexEntry;
  readonly release: UnitReleaseManifest;
  readonly reports: readonly ConformanceReport[];
  readonly [CERTIFIED_UNIT_RELEASE]: true;
}

export type RegistryUnitVerificationResult =
  | { ok: true; value: CertifiedRegistryUnitRelease }
  | { ok: false; errors: string[] };

const certifiedRegistryUnitReleases = new WeakSet<object>();

export function isCertifiedRegistryUnitRelease(value: unknown): value is CertifiedRegistryUnitRelease {
  return typeof value === "object" && value !== null && certifiedRegistryUnitReleases.has(value);
}

function parseJsonBytes(bytes: Uint8Array, label: string, errors: string[]): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    errors.push(`${label}: invalid UTF-8 JSON (${String(error)})`);
    return null;
  }
}

export async function verifyRegistryUnitRelease(
  certified: CertifiedRegistryIndex,
  identity: RegistryUnitIdentity,
  manifestBytes: Uint8Array,
  downloadedReports: readonly DownloadedRegistryDocument[],
  ownerProviders: readonly ContractProviderRef[] = [],
): Promise<RegistryUnitVerificationResult> {
  if (!certifiedRegistryIndexes.has(certified as object)) {
    return { ok: false, errors: ["uncertified registry index"] };
  }
  // Download buffers and their containing records are caller-owned. Snapshot the
  // complete verification closure before the first digest await; the exact bytes
  // hashed are therefore the exact bytes parsed and certified.
  const ownedManifestBytes = Uint8Array.from(manifestBytes);
  const ownedReports = downloadedReports.map((download) => ({
    url: download.url,
    bytes: Uint8Array.from(download.bytes),
  }));
  const errors: string[] = [];
  const entry = certified.index.units.find((candidate) =>
    candidate.kind === identity.kind && candidate.id === identity.id && candidate.version === identity.version
  );
  if (!entry) return { ok: false, errors: ["certified registry does not contain the exact unit release"] };
  const manifestDigest = await digestHex(ownedManifestBytes);
  if (manifestDigest !== entry.manifest.sha256) errors.push("owner release manifest byte digest mismatch");
  const parsedRelease = parseReleaseManifest(parseJsonBytes(ownedManifestBytes, "release manifest", errors));
  if (!parsedRelease.ok) errors.push(...parsedRelease.errors);
  if (!parsedRelease.ok) return { ok: false, errors };
  const release = parsedRelease.value;
  if (release.kind !== entry.kind || release.id !== entry.id || release.version !== entry.version) {
    errors.push("registry identity does not exactly match owner release manifest identity");
  }
  if (!githubReleaseAssetBelongsTo(entry.manifest.url, release.source.repository, release.releaseTag)) {
    errors.push("owner release manifest reference is not in its declared repository and release tag");
  }
  const reportDownloads = new Map<string, Uint8Array>();
  for (const download of ownedReports) {
    if (reportDownloads.has(download.url)) errors.push(`duplicate downloaded report: ${download.url}`);
    reportDownloads.set(download.url, download.bytes);
  }
  if (reportDownloads.size !== entry.reports.length) errors.push("downloaded conformance report set differs from registry references");
  const reports: ConformanceReport[] = [];
  for (const reference of entry.reports) {
    const bytes = reportDownloads.get(reference.url);
    if (!bytes) {
      errors.push(`missing conformance report bytes: ${reference.url}`);
      continue;
    }
    if (await digestHex(bytes) !== reference.sha256) {
      errors.push(`conformance report byte digest mismatch: ${reference.url}`);
      continue;
    }
    if (!githubReleaseAssetBelongsTo(reference.url, release.source.repository, release.releaseTag)) {
      errors.push(`conformance report is outside owner repository/release: ${reference.url}`);
      continue;
    }
    const parsed = parseConformanceReport(parseJsonBytes(bytes, reference.url, errors));
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      continue;
    }
    const verified = verifyConformanceReport(parsed.value, release, manifestDigest, ownerProviders);
    if (!verified.ok) {
      errors.push(...verified.errors.map((error) => `${reference.url}: ${error}`));
      continue;
    }
    reports.push(parsed.value);
  }
  const contractKeys = reports.map((report) => conformanceContractKey(report.contract));
  if (new Set(contractKeys).size !== contractKeys.length) errors.push("duplicate conformance contracts forbidden");
  const required = new Map<string, ConformanceReport["contract"]>(
    requiredConformanceContracts(release.kind).map((contract) => [conformanceContractKey(contract), contract] as const),
  );
  if (release.kind === "sidecar") {
    for (const artifact of release.artifacts) {
      if (artifact.entrypoint.kind === "sidecar") {
        required.set(conformanceContractKey(artifact.entrypoint.interface), artifact.entrypoint.interface);
      }
    }
  }
  for (const [key, contract] of required) {
    if (!contractKeys.includes(key)) {
      errors.push(`missing required conformance report: ${JSON.stringify(contract)}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const verified = deepFreeze({
    registryId: certified.index.registryId,
    entry,
    release,
    reports,
  }) as unknown as CertifiedRegistryUnitRelease;
  certifiedRegistryUnitReleases.add(verified as object);
  return { ok: true, value: verified };
}
