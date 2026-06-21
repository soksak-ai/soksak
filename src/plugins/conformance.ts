// conformance — 플러그인 contribution 의 declared≡actual 정합성(통합).
// v1 법칙: 매니페스트 선언(declared)과 런타임 실제 배선(actual)이 일치한다(양방향).
//  - gateContribution: undeclared-actual 거부(api.ts 4중 find+throw 를 하나로).
//  - missingRegistrations: declared-but-not-actual 감지(activate 후 inventory).
// 앱/DOM 비의존 순수 로직 — vitest 단위검증 대상.

// 선언(declared) 중 id 에 해당하는 엔트리를 찾아 반환. 없으면 fatal throw.
// 메시지: 매니페스트 contributes.<contributesKey> 에 선언되지 않은 <noun>: <id>
export function gateContribution<T>(opts: {
  contributesKey: string; // "commands" | "views" | "fileViewers" | "iconSets" ...
  noun: string; // 한글 명사("명령"/"뷰"/"파일 뷰어"/"셋") — 에러 메시지용
  id: string;
  declared: readonly T[];
  idOf: (entry: T) => string; // commands=name, 그 외=id
}): T {
  const found = opts.declared.find((e) => opts.idOf(e) === opts.id);
  if (!found) {
    throw new Error(
      `매니페스트 contributes.${opts.contributesKey} 에 선언되지 않은 ${opts.noun}: ${opts.id}`,
    );
  }
  return found;
}

// 선언됐는데 등록되지 않은 id 목록(선언 순서 보존). declared-but-not-actual 감지.
// 등록만 있고 선언 없는 건 여기서 다루지 않는다(그건 gateContribution 의 몫 — 양방향 분리).
export function missingRegistrations(
  declaredIds: readonly string[],
  registeredIds: readonly string[],
): string[] {
  const reg = new Set(registeredIds);
  return declaredIds.filter((id) => !reg.has(id));
}
