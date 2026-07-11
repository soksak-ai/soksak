// 내부 검증 유틸 — spec.ts·service.ts 공용(단일 진실 유틸 규칙: inline 재정의 금지).
// 패키지 공개 API 가 아니다 — spec.ts 는 이 모듈을 재수출하지 않는다.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// 선언 안 된 키는 거부(registry.validate 와 동일 철학 — 오타 조기 발견).
export function checkKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${label}: 알 수 없는 키 "${key}"`);
  }
}

export function checkDuplicates(
  values: string[],
  label: string,
  errors: string[],
): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) errors.push(`${label}: 중복 "${v}"`);
    seen.add(v);
  }
}
