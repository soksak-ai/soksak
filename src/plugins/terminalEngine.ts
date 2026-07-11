// 코어의 터미널 어포던스(⌘T·layout.apply dev·설치 명령 가시 실행)가 겨냥하는 단일 seam.
//
// 코어는 어떤 터미널 엔진(구현체)도 모른다 — 터미널 계약(인터페이스)만 참조하고, 어느 엔진을
// 열지는 사용자 설정(contractSelection)이 고른다(R7: 구현이 아니라 공개 인터페이스로 연결). 새
// 엔진은 매니페스트 implements 선언만으로 편입된다 — 코어를 고치지 않는다.
//
// [RULE] 특정 플러그인 id·program id 를 하드코딩하지 않는다. 여기가 이름으로 참조하는 것은 계약
// id(TERMINAL_CONTRACT) 하나 — "터미널을 연다"는 어포던스가 겨냥하는 능력의 이름이다. 계약 발견·
// 선택·해소의 제네릭 기제(contractDiscovery/contractResolve/contractSelection)는 여전히 계약-무지다
// (C1) — 이 파일은 그 기제의 소비자이지 재정의가 아니다.

import { resolveContractImplementer } from "./contractResolve";
import { listPrograms } from "./programRegistry";

// 코어의 터미널 어포던스가 겨냥하는 터미널 계약 id(NAMING §8, <scope>-spec@<major>).
export const TERMINAL_CONTRACT = "terminal-spec@1";

// 설정된 터미널 엔진의 program id 를 해소한다 — addViewToGroup/split/layout 이 program id 로 뷰를 연다.
// 계약 → 구현체 pluginId(설정·발견) → 그 구현체가 자기 뷰로 여는 program id.
// 활성 구현체가 없으면 null — 소비자는 블랭크/skip 으로 열화한다(하드코딩 폴백 없음).
export function resolveTerminalProgram(): string | null {
  const impl = resolveContractImplementer(TERMINAL_CONTRACT);
  if (impl === null) return null;
  // 구현체가 자기 플러그인 뷰로 여는 program(크로스 플러그인 viewPlugin·계약 viewContract 가 아닌
  // 자기 뷰 program)만 후보다 — 터미널 엔진 자신의 뷰 program 을 고른다.
  const prog = listPrograms().find(
    (p) =>
      p.pluginId === impl &&
      p.decl.viewPlugin === undefined &&
      p.decl.viewContract === undefined,
  );
  return prog?.decl.id ?? null;
}
