// semver 비교 유틸 — 의존 해석(플러그인↔플러그인 dependencies·accept.minVersion)의 단일진실.
// spec.ts 가 재수출한다(패키지 공개 API 불변).

export const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

// a vs b: -1(a<b) | 0(a==b) | 1(a>b), major.minor.patch 비교(pre-release 무시). 형식 불량이면 null.
export function semverCompare(a: string, b: string): number | null {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const da = Number(ma[i]);
    const db = Number(mb[i]);
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

// a ≥ b. 형식 불량이면 null. (하위호환 — 기존 재수출·호출부 유지.)
export function semverGte(a: string, b: string): boolean | null {
  const c = semverCompare(a, b);
  return c === null ? null : c >= 0;
}

// 단일 절 판정: * | x.y.z | ^x.y.z | ~x.y.z | (>=|>|<=|<|=)x.y.z. 미인식/불량이면 null.
function satisfiesClause(version: string, clause: string): boolean | null {
  const r = clause.trim();
  if (r === "*" || r === "") return true;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (caret) {
    const [maj, min, pat] = [1, 2, 3].map((i) => Number(caret[i]));
    // caret 상한(npm 의미론): 최상위 비-0 세그먼트를 고정.
    const upper = maj > 0 ? `${maj + 1}.0.0` : min > 0 ? `0.${min + 1}.0` : `0.0.${pat + 1}`;
    const gte = semverGte(version, `${maj}.${min}.${pat}`);
    const c = semverCompare(version, upper);
    return gte === null || c === null ? null : gte && c < 0;
  }
  const tilde = /^~(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (tilde) {
    const [maj, min, pat] = [1, 2, 3].map((i) => Number(tilde[i]));
    const gte = semverGte(version, `${maj}.${min}.${pat}`);
    const c = semverCompare(version, `${maj}.${min + 1}.0`);
    return gte === null || c === null ? null : gte && c < 0;
  }
  // comparator(연산자 생략 = 정확 일치): >= | > | <= | < | = .
  const comp = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(r);
  if (comp) {
    const op = comp[1] || "=";
    const c = semverCompare(version, comp[2]);
    if (c === null) return null;
    switch (op) {
      case ">=": return c >= 0;
      case ">": return c > 0;
      case "<=": return c <= 0;
      case "<": return c < 0;
      case "=": return c === 0;
    }
  }
  return null; // 미인식 절 형태
}

// version 이 range 를 만족하는가. 지원: * | x.y.z | ^x.y.z | ~x.y.z | 비교연산자(>= > <= < =) +
// 공백 구분 복합 범위(AND, 예 ">=1.0.0 <2.0.0"). 의존 시스템이 설치 버전 ↔ 의존 범위 매칭에 쓴다.
// 형식 불량이거나 미인식 절이 하나라도 있으면 null(호출부가 거부 처리 — 조용한 통과 없음).
export function semverSatisfies(version: string, range: string): boolean | null {
  if (!SEMVER_RE.exec(version)) return null;
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return null;
  let result = true;
  for (const clause of clauses) {
    const s = satisfiesClause(version, clause);
    if (s === null) return null; // 미인식/불량 절 → 전체 미판정(과잉통과 금지)
    if (s === false) result = false; // AND — 계속 훑어 뒤의 미인식 절도 포착
  }
  return result;
}
