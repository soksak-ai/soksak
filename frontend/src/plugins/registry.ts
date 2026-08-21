import {
  parseRegistryPublicKey,
  semverCompare,
  semverSatisfies,
  type CertifiedRegistryIndex,
  type LocalizedText,
  type RegistryPublicKey,
  type RegistryReleaseEntry,
  type ReleaseKind,
} from "./spec";

export const OFFICIAL_REGISTRY_ID = "official";

export interface RegistryDescriptor {
  id: string;
  name: string;
  indexUrl: string;
  visibility: "public" | "private";
  trustedPublicKey: RegistryPublicKey;
  /** Core-derived vault location. A descriptor cannot select this value. */
  credentialRef?: string;
}

export interface RegistryCredentialSlot {
  namespace: string;
  key: "http-authorization";
  ref: string;
}

export interface QualifiedRegistryEntry extends RegistryReleaseEntry {
  registryId: string;
}

/** Catalog entries are authenticated release references, never repository locators. */
export type RegistryEntry = QualifiedRegistryEntry;

const REGISTRY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REGISTRY_CREDENTIAL_KEY = "http-authorization" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

export function registryCredentialSlot(registryId: string): RegistryCredentialSlot | null {
  if (!REGISTRY_ID_RE.test(registryId)) return null;
  const encodedId = [...registryId].map((character) => {
    if (character === "-") return "--";
    if (character === ".") return "-d";
    if (character === "_") return "-u";
    return character;
  }).join("");
  const namespace = `core_registry-${encodedId}`;
  return {
    namespace,
    key: REGISTRY_CREDENTIAL_KEY,
    ref: `${namespace}/${REGISTRY_CREDENTIAL_KEY}`,
  };
}

export function isRegistryIndexUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f\\?#]/.test(value)
  ) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.toString() === value;
  } catch {
    return false;
  }
}

export function parseRegistryDescriptor(raw: unknown): RegistryDescriptor | null {
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, ["credentialRef", "id", "indexUrl", "name", "trustedPublicKey", "visibility"]) ||
    typeof raw.id !== "string" ||
    !REGISTRY_ID_RE.test(raw.id) ||
    typeof raw.name !== "string" ||
    raw.name.trim().length === 0 ||
    raw.name.length > 128 ||
    !isRegistryIndexUrl(raw.indexUrl) ||
    (raw.visibility !== "public" && raw.visibility !== "private")
  ) return null;
  const key = parseRegistryPublicKey(raw.trustedPublicKey);
  if (!key.ok) return null;
  if (raw.visibility === "public") {
    if (raw.credentialRef !== undefined) return null;
    return {
      id: raw.id,
      name: raw.name,
      indexUrl: raw.indexUrl,
      visibility: "public",
      trustedPublicKey: key.value,
    };
  }
  const credential = registryCredentialSlot(raw.id);
  if (!credential || (raw.credentialRef !== undefined && raw.credentialRef !== credential.ref)) return null;
  return {
    id: raw.id,
    name: raw.name,
    indexUrl: raw.indexUrl,
    visibility: "private",
    trustedPublicKey: key.value,
    credentialRef: credential.ref,
  };
}

export function qualifyRegistry(
  certified: CertifiedRegistryIndex,
): QualifiedRegistryEntry[] {
  return certified.index.units.map((entry) => ({
    ...entry,
    registryId: certified.index.registryId,
  }));
}

export type RegistryReleaseResolution =
  | { ok: true; entry: QualifiedRegistryEntry }
  | {
      ok: false;
      reason: "not_found" | "qualification_required" | "ambiguous";
      candidates: { registryId: string; id: string; version: string }[];
    };

export function resolveRegistryRelease(
  entries: readonly QualifiedRegistryEntry[],
  target: {
    registryId?: string;
    id: string;
    kind?: ReleaseKind;
    range?: string;
  },
): RegistryReleaseResolution {
  const matches = entries.filter((entry) =>
    entry.id === target.id &&
    (target.registryId === undefined || entry.registryId === target.registryId) &&
    (target.kind === undefined || entry.kind === target.kind) &&
    (target.range === undefined || semverSatisfies(entry.version, target.range) === true)
  );
  const candidates = matches
    .map(({ registryId, id, version }) => ({ registryId, id, version }))
    .sort((left, right) =>
      left.registryId.localeCompare(right.registryId) ||
      -(semverCompare(left.version, right.version) ?? 0)
    );
  if (matches.length === 0) return { ok: false, reason: "not_found", candidates };
  const registries = new Set(matches.map((entry) => entry.registryId));
  if (registries.size > 1) return { ok: false, reason: "ambiguous", candidates };
  const registryId = matches[0].registryId;
  if (target.registryId === undefined && registryId !== OFFICIAL_REGISTRY_ID) {
    return { ok: false, reason: "qualification_required", candidates };
  }
  const entry = [...matches].sort(
    (left, right) => -(semverCompare(left.version, right.version) ?? 0),
  )[0];
  return { ok: true, entry };
}

export type InstallState = "available" | "installed" | "update";

export function installState(
  entry: Pick<RegistryReleaseEntry, "version">,
  installedVersion?: string,
  installedSource?: "installed" | "dev",
): InstallState {
  if (!installedVersion) return "available";
  if (installedSource === "dev") return "installed";
  if (
    entry.version !== installedVersion &&
    semverCompare(entry.version, installedVersion) === 1
  ) return "update";
  return "installed";
}

export function isOfficial(
  entries: readonly QualifiedRegistryEntry[],
  id: string,
): boolean {
  return entries.some((entry) =>
    entry.registryId === OFFICIAL_REGISTRY_ID &&
    entry.kind === "plugin" &&
    entry.id === id
  );
}

/** A catalog has no authority to supply display metadata before its owner release is verified. */
export function catalogLabel(entry: Pick<QualifiedRegistryEntry, "id">): LocalizedText {
  return entry.id;
}
