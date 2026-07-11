// semver 비교 유틸 — 의존 해석(플러그인↔플러그인 dependencies·accept.minVersion)의 단일진실.
// spec.ts 가 재수출한다(패키지 공개 API 불변).

export const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

// a ≥ b (major.minor.patch 비교, pre-release 무시). 형식 불량이면 null.
export function semverGte(a: string, b: string): boolean | null {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const da = Number(ma[i]);
    const db = Number(mb[i]);
    if (da !== db) return da > db;
  }
  return true;
}

// version 이 range 를 만족하는가(npm 류 부분집합: * | x.y.z | ^x.y.z | ~x.y.z | >=x.y.z).
// 의존 시스템이 설치 버전 ↔ 의존 범위 매칭에 쓴다. 형식 불량이면 null(호출부가 거부 처리).
export function semverSatisfies(version: string, range: string): boolean | null {
  const v = SEMVER_RE.exec(version);
  if (!v) return null;
  const r = range.trim();
  if (r === "*") return true;
  const num = (m: RegExpExecArray, i: number) => Number(m[i]);
  // lower(포함) ≤ version < upper(미포함). caret/tilde 상한 계산은 npm 의미론.
  const lt = (a: string, b: string): boolean => semverGte(a, b) === false;
  const cmp = />=(\d+\.\d+\.\d+)$/.exec(r);
  if (cmp) return semverGte(version, cmp[1]) === true;
  const exact = /^(\d+\.\d+\.\d+)$/.exec(r);
  if (exact) return `${num(v, 1)}.${num(v, 2)}.${num(v, 3)}` === exact[1];
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (caret) {
    const [maj, min, pat] = [1, 2, 3].map((i) => Number(caret[i]));
    const base = `${maj}.${min}.${pat}`;
    const upper = maj > 0 ? `${maj + 1}.0.0` : min > 0 ? `0.${min + 1}.0` : `0.0.${pat + 1}`;
    return semverGte(version, base) === true && lt(version, upper);
  }
  const tilde = /^~(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (tilde) {
    const [maj, min, pat] = [1, 2, 3].map((i) => Number(tilde[i]));
    const base = `${maj}.${min}.${pat}`;
    const upper = `${maj}.${min + 1}.0`;
    return semverGte(version, base) === true && lt(version, upper);
  }
  return null;
}
