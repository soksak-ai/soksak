// ui.* 보더 계약 명령 — 검증기(borderValidate)와 기대 조회를 CLI/MCP 로 노출.
// red→green 의 실행 단추: sok ui.validate 한 줄이 RED/GREEN 판정이다.
// (ui.measure 는 catalog.ts 에 — R5 수치 검증. 여기는 §B 계약 전용.)

import { expectForSelector, validateDom } from "../ui/borderValidate";
import { register } from "./registry";

export function registerUiCatalog(): void {
  register("ui.validate", {
    description:
      "보더 소유권 계약(docs/UI.md §B) 검증 — 살아있는 DOM 의 4변 computed border 를 계약 테이블과 대조해 위반을 적발",
    params: {
      rule: {
        type: "string",
        description: "규칙 id/셀렉터 부분 일치 필터(생략 시 전체)",
      },
    },
    returns: "{ pass, rulesActive, elementsChecked, violations: [{rule, selector, index, edge, expected, actual}] }",
    examples: ["sok ui.validate", 'sok ui.validate \'{"rule":"status"}\''],
    handler: (p) => ({ ...validateDom(p.rule as string | undefined) }),
  });

  register("ui.expect", {
    description:
      "지정 DOM 에 어느 변의 어떤 보더가 있어야 하는지 계약 기준으로 알려준다(규칙 없음도 답 — 필요하면 계약 테이블에 추가가 정도)",
    params: {
      selector: { type: "string", description: "CSS 셀렉터", required: true },
    },
    returns: "{ matchedElements, rules: [{id, active, kind, edges?, seam?, note}] }",
    examples: ['sok ui.expect \'{"selector":".egroup-status"}\''],
    handler: (p) => ({ ...expectForSelector(p.selector as string) }),
  });
}
