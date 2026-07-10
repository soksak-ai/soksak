// 계약 id — C3 L2 계약-핀의 문법 단일진실(NAMING §8).
//
// 문법: <scope>-spec@<major>. scope = 지배하는 도메인, "-spec" = 의무 kind 마커,
// major = 판. 계약 id 는 파생이지 발명이 아니다 — scope 는 도메인을 명명하지
// 구현체·엔진·모델을 명명하지 않는다.
//
// implements 의 의미(매니페스트 선언):
//   - 선언 = 발견 대상. 이 플러그인이 그 계약의 구현임을 밝히고, 소비자는 계약 id 로만
//     발견한다(구현체 무차별). 구현 pluginId 를 핀하지 마라(L1 이름-핀 — 신규 결합 금지).
//   - 판올림 = major 별 id. <scope>-spec@2 는 @1 과 호환을 약속하지 않는다 — @2 선언이
//     @1 선언을 대체하지 않는다. 판 개정은 명시 재입법으로만 한다(C4).
//   - 계약 id 의 등장 표면은 선언된 두 곳뿐이다: 사이드카 핸드셰이크(sidecars[].interface)와
//     이 implements 선언. 다른 곳에 계약 id 를 두지 마라(NAMING §8).

// SIDECAR_INTERFACE_RE(^[a-z0-9][a-z0-9.-]*@[0-9]+$)와 동형 + 의무 kind 마커 "-spec".
export const CONTRACT_ID_RE = /^[a-z0-9][a-z0-9.-]*-spec@[0-9]+$/;

// implements 검증 — 문법 위반·중복은 전부 거부한다(§0-3 all-or-nothing, 부분 수용 금지).
// 반환 = trim 정규화된 계약 id 목록(에러 시 빈 배열 — 호출자는 errors 로 거부한다).
export function validateImplements(raw: unknown, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push("implements: 계약 id 문자열 배열이어야 함(<scope>-spec@<major>)");
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  let bad = false;
  raw.forEach((item, i) => {
    if (typeof item !== "string" || !CONTRACT_ID_RE.test(item.trim())) {
      errors.push(
        `implements[${i}]: 계약 id <scope>-spec@<major> 필수(^[a-z0-9][a-z0-9.-]*-spec@[0-9]+$ — 예: soksak-agent-sessions-spec@1). 구현체 이름·판 없는 이름은 계약 id 가 아니다(NAMING §8)`,
      );
      bad = true;
      return;
    }
    const id = item.trim();
    if (seen.has(id)) {
      errors.push(`implements: 중복 "${id}"`);
      bad = true;
      return;
    }
    seen.add(id);
    out.push(id);
  });
  return bad ? [] : out;
}
