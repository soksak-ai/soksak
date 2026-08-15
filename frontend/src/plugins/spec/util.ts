// Internal validation utils — shared by spec.ts and service.ts (single-source util rule: no inline redefinition).
// Not part of the package public API — spec.ts does not re-export this module.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// Undeclared keys are rejected (same principle as registry.validate — catch typos early).
export function checkKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${label}: unknown key "${key}"`);
  }
}

export function checkDuplicates(
  values: string[],
  label: string,
  errors: string[],
): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) errors.push(`${label}: duplicate "${v}"`);
    seen.add(v);
  }
}
