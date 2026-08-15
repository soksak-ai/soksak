// SemVer grammar, deterministic dependency-range subset, and precedence.
// This module has no product or package baseline: each unit owns its version,
// while repository policy/CI decides which version is current.

export const MAX_SEMVER_LENGTH = 256;
const NUMERIC_IDENTIFIER = String.raw`(?:0|[1-9][0-9]*)`;
const PRERELEASE_IDENTIFIER = String.raw`(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
export const STRICT_SEMVER_PATTERN =
  NUMERIC_IDENTIFIER +
  String.raw`\.` + NUMERIC_IDENTIFIER +
  String.raw`\.` + NUMERIC_IDENTIFIER +
  String.raw`(?:-` + PRERELEASE_IDENTIFIER + String.raw`(?:\.` + PRERELEASE_IDENTIFIER + String.raw`)*)?` +
  String.raw`(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?`;
export const STRICT_SEMVER_RE = new RegExp(
  String.raw`^(?=.{1,` + MAX_SEMVER_LENGTH + String.raw`}$)` + STRICT_SEMVER_PATTERN + String.raw`$`,
);
export const SEMVER_RE = STRICT_SEMVER_RE;

export function isStrictSemver(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SEMVER_LENGTH && STRICT_SEMVER_RE.test(value);
}

export const MAX_UNIT_DEPENDENCY_RANGE_LENGTH = 512;
export const MAX_UNIT_DEPENDENCY_CLAUSES = 16;

export function isUnitDependencyRange(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_UNIT_DEPENDENCY_RANGE_LENGTH ||
    value !== value.trim() ||
    value.includes("||")
  ) {
    return false;
  }
  if (value === "*") return true;
  const clauses = value.split(" ");
  if (
    clauses.length === 0 ||
    clauses.length > MAX_UNIT_DEPENDENCY_CLAUSES ||
    clauses.some((clause) => clause.length === 0 || clause === "*")
  ) return false;
  return clauses.every((clause) => {
    const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(clause);
    return match !== null && isStrictSemver(match[2]);
  });
}

interface ParsedSemver {
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly string[] | null;
}

function parseSemver(value: string): ParsedSemver | null {
  if (!isStrictSemver(value)) return null;
  const withoutBuild = value.split("+", 1)[0];
  const dash = withoutBuild.indexOf("-");
  const coreRaw = dash < 0 ? withoutBuild : withoutBuild.slice(0, dash);
  const prerelease = dash < 0 ? null : withoutBuild.slice(dash + 1).split(".");
  const [major, minor, patch] = coreRaw.split(".").map((part) => BigInt(part));
  return { core: [major, minor, patch], prerelease };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^[0-9]+$/.test(left);
  const rightNumeric = /^[0-9]+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

// a vs b: -1(a<b) | 0(a==b) | 1(a>b). Build metadata is intentionally ignored.
// Invalid input returns null so callers cannot turn malformed versions into matches.
export function semverCompare(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (left.prerelease === null || right.prerelease === null) {
    return left.prerelease === right.prerelease ? 0 : left.prerelease === null ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    const compared = compareIdentifier(leftPart, rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function semverGte(a: string, b: string): boolean | null {
  const compared = semverCompare(a, b);
  return compared === null ? null : compared >= 0;
}

function upperBound(base: ParsedSemver, operator: "^" | "~"): string {
  const [major, minor, patch] = base.core;
  if (operator === "~") return `${major}.${minor + 1n}.0`;
  if (major > 0n) return `${major + 1n}.0.0`;
  if (minor > 0n) return `0.${minor + 1n}.0`;
  return `0.0.${patch + 1n}`;
}

function satisfiesClause(version: string, clause: string): boolean | null {
  if (clause === "*") return true;
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(clause);
  if (!match) return null;
  const operator = match[1] ?? "=";
  const boundary = parseSemver(match[2]);
  if (!boundary) return null;
  const compared = semverCompare(version, match[2]);
  if (compared === null) return null;
  if (operator === "^" || operator === "~") {
    const lower = compared >= 0;
    const upper = semverCompare(version, upperBound(boundary, operator));
    return upper === null ? null : lower && upper < 0;
  }
  switch (operator) {
    case ">=": return compared >= 0;
    case ">": return compared > 0;
    case "<=": return compared <= 0;
    case "<": return compared < 0;
    case "=": return compared === 0;
  }
  return null;
}

function clauseNamesSameCorePrerelease(version: ParsedSemver, clause: string): boolean {
  if (clause === "*") return false;
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(clause);
  if (!match) return false;
  const boundary = parseSemver(match[2]);
  return boundary?.prerelease !== null &&
    boundary !== null &&
    boundary.core.every((part, index) => part === version.core[index]);
}

// Supported deterministic subset: *; exact; ^; ~; >=, >, <=, <, =; and
// whitespace-separated AND clauses. `||`, partial versions and tags are rejected.
export function semverSatisfies(version: string, range: string): boolean | null {
  const parsedVersion = parseSemver(version);
  if (!parsedVersion || !isUnitDependencyRange(range)) return null;
  const clauses = range.split(" ");
  let result = true;
  for (const clause of clauses) {
    const satisfied = satisfiesClause(version, clause);
    if (satisfied === null) return null;
    if (!satisfied) result = false;
  }
  if (
    result &&
    parsedVersion.prerelease !== null &&
    !clauses.some((clause) => clauseNamesSameCorePrerelease(parsedVersion, clause))
  ) {
    return false;
  }
  return result;
}
