// Public domain-contract references have two deliberately different shapes:
//
//   provider/evidence: { id, version }  — exact bytes were tested against one version
//   consumer:          { id, range }    — discovery accepts compatible providers
//
// The base id never embeds a version. `name@version` discovery is forbidden because it
// collapses identity and compatibility into exact string equality. Platform schema ids
// such as `soksak-spec-plugin@0.0.1` are a different namespace and remain exact strings.
//
// A contract id is a plain name — `sidebar-file-tree`, `browser`. It wore
// `soksak-spec-<kind>-` until 2026-08-16, and the reason written down for the prefix was that a
// scanner could then tell a contract id from a plugin id in core sources. The core names no
// contract it does not define (coupling_gate_test.go), so nothing in core sources can be confused,
// and a rule shaped to suit a scanner is the scanner writing the rule.
//
// The kind is not in the name either. Whether a plugin or a sidecar provides a thing is the
// provider's business, and a consumer that had to know would be coupled to the implementation (C3).
import { isStrictSemver, isUnitDependencyRange, semverSatisfies } from "./semver";
import { checkKnownKeys, isRecord } from "./util";

export const CONTRACT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// A sidecar's interface is a contract like any other — one shape, kept as its own name so the call
// sites read as what they check rather than as a coincidence.
export const SIDECAR_CONTRACT_ID_RE = CONTRACT_ID_RE;
// The service protocol is the core's own, and its id is a platform string rather than a name two
// plugins meet at.
export const SERVICE_CONTRACT_ID_RE = /^soksak-spec-service(?:-[a-z0-9][a-z0-9-]*)?$/;

export interface ContractProviderRef {
  id: string;
  version: string;
}

export interface ContractRequirement {
  id: string;
  range: string;
}

function parseContractObject(
  raw: unknown,
  valueKey: "version" | "range",
  label: string,
  errors: string[],
  idPattern: RegExp = CONTRACT_ID_RE,
): ContractProviderRef | ContractRequirement | null {
  if (!isRecord(raw)) {
    errors.push(`${label}: { id, ${valueKey} } object required`);
    return null;
  }
  const before = errors.length;
  checkKnownKeys(raw, ["id", valueKey], label, errors);
  if (typeof raw.id !== "string" || !idPattern.test(raw.id)) {
    errors.push(`${label}.id: version-free public contract id required`);
  }
  if (valueKey === "version") {
    if (!isStrictSemver(raw.version)) errors.push(`${label}.version: strict SemVer required`);
  } else if (!isUnitDependencyRange(raw.range)) {
    errors.push(`${label}.range: supported SemVer range required`);
  }
  if (errors.length !== before) return null;
  return valueKey === "version"
    ? { id: raw.id as string, version: raw.version as string }
    : { id: raw.id as string, range: raw.range as string };
}

export function parseContractProviderRef(
  raw: unknown,
  label: string,
  errors: string[],
  idPattern: RegExp = CONTRACT_ID_RE,
): ContractProviderRef | null {
  return parseContractObject(raw, "version", label, errors, idPattern) as ContractProviderRef | null;
}

export function parseContractRequirement(
  raw: unknown,
  label: string,
  errors: string[],
  idPattern: RegExp = CONTRACT_ID_RE,
): ContractRequirement | null {
  return parseContractObject(raw, "range", label, errors, idPattern) as ContractRequirement | null;
}

export function contractRequirementSatisfiedBy(
  requirement: ContractRequirement,
  provider: ContractProviderRef,
): boolean {
  return requirement.id === provider.id && semverSatisfies(provider.version, requirement.range) === true;
}

export function contractProviderKey(provider: ContractProviderRef): string {
  return `${provider.id}\u0000${provider.version}`;
}

export function contractRequirementKey(requirement: ContractRequirement): string {
  return `${requirement.id}\u0000${requirement.range}`;
}

export function validateImplements(raw: unknown, errors: string[]): ContractProviderRef[] {
  return validateContractArray(raw, "implements", "provider", errors) as ContractProviderRef[];
}

export function validateConsumes(raw: unknown, errors: string[]): ContractRequirement[] {
  return validateContractArray(raw, "consumes", "requirement", errors) as ContractRequirement[];
}

function validateContractArray(
  raw: unknown,
  field: string,
  direction: "provider" | "requirement",
  errors: string[],
): (ContractProviderRef | ContractRequirement)[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${field}: contract reference array required`);
    return [];
  }
  const out: (ContractProviderRef | ContractRequirement)[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const parsed = direction === "provider"
      ? parseContractProviderRef(item, `${field}[${index}]`, errors)
      : parseContractRequirement(item, `${field}[${index}]`, errors);
    if (!parsed) return;
    if (seen.has(parsed.id)) {
      errors.push(`${field}: duplicate contract id "${parsed.id}"`);
      return;
    }
    seen.add(parsed.id);
    out.push(parsed);
  });
  return out;
}
