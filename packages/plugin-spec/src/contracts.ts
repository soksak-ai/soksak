// 계약 id — C3 L2 계약-핀의 문법 단일진실(NAMING §8).
//
// 문법: soksak-spec-<kind>-<domain>@<major>. "soksak-spec-" = 계약 id 표지(항상 앞),
// kind ∈ {sidecar, plugin, service}, domain = 지배하는 도메인, major = 판. kind 가 곧
// 도메인인 시스템 계약은 domain 을 생략한다(soksak-spec-plugin·soksak-spec-service). 계약
// id 는 파생이지 발명이 아니다 — domain 은 도메인을 명명하지 구현체·엔진·모델을 명명하지 않는다.
//
// implements 의 의미(매니페스트 선언):
//   - 선언 = 발견 대상. 이 플러그인이 그 계약의 구현임을 밝히고, 소비자는 계약 id 로만
//     발견한다(구현체 무차별). 구현 pluginId 를 핀하지 마라(L1 이름-핀 — 신규 결합 금지).
//   - 판올림 = major 별 id. soksak-spec-<…>@2 는 @1 과 호환을 약속하지 않는다 — @2 선언이
//     @1 선언을 대체하지 않는다. 판 개정은 명시 재입법으로만 한다(C4).
//   - 계약 id 의 등장 표면은 선언된 다섯 곳이다: 사이드카 핸드셰이크(sidecars[].interface),
//     서비스 wire(service.interface), implements(구현 선언), consumes(호출 선언),
//     viewContract(뷰 소비 선언). 다른 곳에 계약 id 를 두지 마라(NAMING §8).

// 모든 계약 id 는 "soksak-spec-<kind>" 로 시작한다(kind ∈ sidecar|plugin|service — 정규식이
// 어휘를 강제한다). kind 는 도메인이 아니다 — 임의 토큰(fixture 등)은 kind 가 아니므로 거부되고,
// 새 kind 는 정규식 개정(C4 재입법)으로만 는다. 이로써 grep 한 번에 발견되고, C1 결합 스캔이 계약
// id 를 플러그인 id(soksak-plugin-<name>)로 오탐하지 않는다. major 는 정규형만 받는다(0 또는 선행 0
// 없는 십진수) — "@01" 같은 별칭 표기가 통과하면 같은 계약이 두 문자열로 공존해 정확-문자열
// 발견(implementersOf)이 구현체를 놓친다. wire-계약 크레이트(soksak-spec-<domain>, @ 없음)와
// 계약 id(@major 필수)는 @ 유무로 구분된다.
export const CONTRACT_ID_RE = /^soksak-spec-(sidecar|plugin|service)(-[a-z0-9][a-z0-9-]*)?@(0|[1-9][0-9]*)$/;

// implements 검증 — 문법 위반·중복은 전부 거부한다(§0-3 all-or-nothing, 부분 수용 금지).
// 반환 = trim 정규화된 계약 id 목록(에러 시 빈 배열 — 호출자는 errors 로 거부한다).
export function validateImplements(raw: unknown, errors: string[]): string[] {
  return validateContractIds(raw, "implements", errors);
}

// 소비자 축 — 이 플러그인이 부를 계약. implements 의 대칭이고 같은 문법을 쓴다: 선언하는 것은
// 계약이지 구현체가 아니다. 호출 경계는 이것으로 강제된다(코어 crossPluginDenyReason) — 소비자가
// 계약을 선언하면 그 계약을 구현한다고 선언한 플러그인은 누구든 부를 수 있고, 그 밖은 거부된다.
export function validateConsumes(raw: unknown, errors: string[]): string[] {
  return validateContractIds(raw, "consumes", errors);
}

function validateContractIds(raw: unknown, field: string, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${field}: 계약 id 문자열 배열이어야 함(soksak-spec-<kind>-<domain>@<major>)`);
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  let bad = false;
  raw.forEach((item, i) => {
    if (typeof item !== "string" || !CONTRACT_ID_RE.test(item.trim())) {
      errors.push(
        `${field}[${i}]: 계약 id soksak-spec-<kind>-<domain>@<major> 필수(^soksak-spec-[a-z0-9][a-z0-9-]*@[0-9]+$ — 예: soksak-spec-plugin-agent-sessions@1). 구현체 이름·판 없는 이름은 계약 id 가 아니다(NAMING §8)`,
      );
      bad = true;
      return;
    }
    const id = item.trim();
    if (seen.has(id)) {
      errors.push(`${field}: 중복 "${id}"`);
      bad = true;
      return;
    }
    seen.add(id);
    out.push(id);
  });
  return bad ? [] : out;
}
