// Portable conformance evidence. Reports are immutable release assets and bind one
// enacted contract to the exact owner manifest plus every artifact in its matrix.
import {
  type ContractProviderRef,
  contractProviderKey,
  parseContractProviderRef,
} from "./contracts.js";
import { type PlatformParseResult, type UnitReleaseManifest } from "./release.js";
import {
  CONFORMANCE_REPORT_SPEC,
  RELEASE_SPEC,
  SHA256_RE,
  STRICT_SEMVER_RE,
  UNIT_ID_RE,
  UNIT_SPEC_BY_KIND,
  isStrictSemver,
  isUnitKind,
  isUnitTarget,
  type UnitKind,
  type UnitTarget,
} from "./unit.js";
import { checkKnownKeys, isRecord } from "./util.js";

export interface ConformanceSubject {
  kind: UnitKind;
  id: string;
  version: string;
  manifestSha256: string;
}

export interface ConformanceArtifactSubject {
  target: UnitTarget;
  sha256: string;
}

export interface ConformanceValidator {
  name: string;
  version: string;
}

export interface ConformanceReport {
  spec: typeof CONFORMANCE_REPORT_SPEC;
  subject: ConformanceSubject;
  contract: PlatformConformanceContract | ContractProviderRef;
  result: "passed";
  validator: ConformanceValidator;
  artifacts: ConformanceArtifactSubject[];
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

export type PlatformConformanceContract =
  | typeof RELEASE_SPEC
  | (typeof UNIT_SPEC_BY_KIND)[UnitKind];

function isPlatformConformanceContract(value: unknown): value is PlatformConformanceContract {
  return typeof value === "string" && (
    value === RELEASE_SPEC ||
    value === UNIT_SPEC_BY_KIND.kit ||
    value === UNIT_SPEC_BY_KIND.plugin ||
    value === UNIT_SPEC_BY_KIND.sidecar
  );
}

export function conformanceContractKey(
  contract: PlatformConformanceContract | ContractProviderRef,
): string {
  return typeof contract === "string"
    ? `schema\u0000${contract}`
    : `domain\u0000${contractProviderKey(contract)}`;
}

export function requiredConformanceContracts(kind: UnitKind): PlatformConformanceContract[] {
  return [RELEASE_SPEC, UNIT_SPEC_BY_KIND[kind]].sort();
}

export function parseConformanceReport(raw: unknown): PlatformParseResult<ConformanceReport> {
  const errors: string[] = [];
  const value = strictObject(
    raw,
    ["artifacts", "contract", "result", "spec", "subject", "validator"],
    ["artifacts", "contract", "result", "spec", "subject", "validator"],
    "conformance",
    errors,
  );
  if (!value) return { ok: false, errors };
  if (value.spec !== CONFORMANCE_REPORT_SPEC) {
    errors.push(`conformance.spec: ${CONFORMANCE_REPORT_SPEC} required`);
  }
  let contract: PlatformConformanceContract | ContractProviderRef | null = null;
  if (isPlatformConformanceContract(value.contract)) {
    contract = value.contract;
  } else {
    contract = parseContractProviderRef(value.contract, "conformance.contract", errors);
  }
  if (value.result !== "passed") errors.push("conformance.result: passed required for install evidence");

  const subjectRaw = strictObject(
    value.subject,
    ["id", "kind", "manifestSha256", "version"],
    ["id", "kind", "manifestSha256", "version"],
    "conformance.subject",
    errors,
  );
  let subject: ConformanceSubject | null = null;
  if (subjectRaw) {
    const before = errors.length;
    if (!isUnitKind(subjectRaw.kind)) errors.push("conformance.subject.kind: kit|plugin|sidecar required");
    if (typeof subjectRaw.id !== "string" || !UNIT_ID_RE.test(subjectRaw.id)) {
      errors.push("conformance.subject.id: flat unit id required");
    }
    if (!isStrictSemver(subjectRaw.version)) errors.push("conformance.subject.version: strict SemVer required");
    if (!SHA256_RE.test(typeof subjectRaw.manifestSha256 === "string" ? subjectRaw.manifestSha256 : "")) {
      errors.push("conformance.subject.manifestSha256: exact lowercase SHA-256 required");
    }
    if (errors.length === before) {
      subject = {
        kind: subjectRaw.kind as UnitKind,
        id: subjectRaw.id as string,
        version: subjectRaw.version as string,
        manifestSha256: subjectRaw.manifestSha256 as string,
      };
    }
  }

  const validatorRaw = strictObject(
    value.validator,
    ["name", "version"],
    ["name", "version"],
    "conformance.validator",
    errors,
  );
  let validator: ConformanceValidator | null = null;
  if (validatorRaw) {
    const before = errors.length;
    if (typeof validatorRaw.name !== "string" || !UNIT_ID_RE.test(validatorRaw.name)) {
      errors.push("conformance.validator.name: flat tool id required");
    }
    if (typeof validatorRaw.version !== "string" || !STRICT_SEMVER_RE.test(validatorRaw.version)) {
      errors.push("conformance.validator.version: strict SemVer required");
    }
    if (errors.length === before) {
      validator = { name: validatorRaw.name as string, version: validatorRaw.version as string };
    }
  }

  const artifacts: ConformanceArtifactSubject[] = [];
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    errors.push("conformance.artifacts: non-empty array required");
  } else {
    value.artifacts.forEach((item, index) => {
      const label = `conformance.artifacts[${index}]`;
      const before = errors.length;
      const artifact = strictObject(item, ["sha256", "target"], ["sha256", "target"], label, errors);
      if (!artifact) return;
      if (!isUnitTarget(artifact.target)) errors.push(`${label}.target: canonical unit target required`);
      if (!SHA256_RE.test(typeof artifact.sha256 === "string" ? artifact.sha256 : "")) {
        errors.push(`${label}.sha256: exact lowercase SHA-256 required`);
      }
      if (errors.length === before) {
        artifacts.push({ target: artifact.target as UnitTarget, sha256: artifact.sha256 as string });
      }
    });
    const keys = artifacts.map((artifact) => artifact.target);
    if (new Set(keys).size !== keys.length) errors.push("conformance.artifacts: duplicate targets forbidden");
    const sorted = [...keys].sort();
    if (keys.some((key, index) => key !== sorted[index])) errors.push("conformance.artifacts: targets must be sorted");
  }

  if (errors.length > 0 || !subject || !validator || !contract) return { ok: false, errors };
  return {
    ok: true,
    value: {
      spec: CONFORMANCE_REPORT_SPEC,
      subject,
      contract,
      result: "passed",
      validator,
      artifacts,
    },
  };
}

export type ConformanceVerificationResult = { ok: true } | { ok: false; errors: string[] };

export function verifyConformanceReport(
  report: ConformanceReport,
  release: UnitReleaseManifest,
  manifestSha256: string,
  ownerProviders: readonly ContractProviderRef[] = [],
): ConformanceVerificationResult {
  const errors: string[] = [];
  if (report.subject.kind !== release.kind) errors.push("conformance subject kind mismatch");
  if (report.subject.id !== release.id) errors.push("conformance subject id mismatch");
  if (report.subject.version !== release.version) errors.push("conformance subject version mismatch");
  if (report.subject.manifestSha256 !== manifestSha256) errors.push("conformance manifest digest mismatch");
  const expected = release.artifacts.map(({ target, sha256 }) => ({ target, sha256 }));
  if (JSON.stringify(report.artifacts) !== JSON.stringify(expected)) {
    errors.push("conformance artifact coverage must exactly match the owner release matrix");
  }
  if (typeof report.contract !== "string") {
    const declaredProviders = [...ownerProviders];
    if (release.kind === "sidecar") {
      for (const artifact of release.artifacts) {
        if (artifact.entrypoint.kind === "sidecar") declaredProviders.push(artifact.entrypoint.interface);
      }
    }
    const wanted = contractProviderKey(report.contract);
    if (!declaredProviders.some((provider) => contractProviderKey(provider) === wanted)) {
      errors.push("conformance domain contract is not declared by the owner");
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
