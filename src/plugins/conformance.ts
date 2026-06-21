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

// nodes 의 declared≡actual 진단. actual = DOM 의 data-node(scanNodes 의 nodePath).
// 동적 리스트 노드는 "id/key" 형태라 base id(첫 세그먼트)로 매칭한다. nodes 는 register API 가 없는
// contribution 이므로 게이트(throw)가 아니라 진단을 낸다:
//   missing = 선언했으나 DOM 에 미배선(declared→actual), orphan = DOM 에 있으나 미선언(actual→declared).
export function nodeConformance(
  declaredIds: readonly string[],
  scannedNodePaths: readonly string[],
): { missing: string[]; orphan: string[] } {
  const declared = new Set(declaredIds);
  const scannedBase = new Set(scannedNodePaths.map((p) => p.split("/")[0]));
  return {
    missing: declaredIds.filter((id) => !scannedBase.has(id)),
    orphan: [...scannedBase].filter((id) => !declared.has(id)),
  };
}
