// 보더 계약 런타임 검증기 — 계약 테이블(borderContract)을 살아있는 DOM 에 적용.
// 순수 평가 코어(evaluateRules — env 주입)와 DOM 바인딩(domEnv)을 분리:
// 코어는 vitest 픽스처로 전수 검증(위반을 심으면 RED 가 떠야 검증기 자격이 있다),
// DOM 바인딩은 ui.validate/ui.expect 명령이 소비한다.

import {
  BORDER_RULES,
  EDGE_NAMES,
  type BorderRule,
  type EdgeExpect,
  type EdgeName,
  type RuleWhen,
} from "./borderContract";

export interface EdgeProbe {
  width: string; // computed border{Edge}Width — "0px"/"1px"…
  style: string; // computed border{Edge}Style — "none"/"solid"…
  color: string; // computed border{Edge}Color — 정규화된 rgb()/rgba()
}

export interface ElementProbe {
  edges: Record<EdgeName, EdgeProbe>;
  backgroundColor: string;
  backgroundImage: string; // seam 중앙선 판정용
  visible: boolean;
}

export interface ValidateEnv {
  queryAll(selector: string): ElementProbe[];
  // 루트 data-* (테마 chrome 토큰). 미설정이면 undefined.
  dataset(name: keyof RuleWhen): string | undefined;
  // 토큰의 정규화된 색(rgb()/rgba()) — DOM 에선 프로브 요소로 resolve.
  resolveToken(token: "bd" | "bd-soft"): string;
}

export interface Violation {
  rule: string; // 규칙 id
  selector: string;
  index: number; // 매치 중 몇 번째 요소
  edge: EdgeName | "seam";
  expected: string;
  actual: string;
}

export interface ValidateResult {
  pass: boolean;
  rulesActive: number; // when 조건 통과한 규칙 수
  elementsChecked: number;
  violations: Violation[];
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

function whenActive(when: RuleWhen | undefined, env: ValidateEnv): boolean {
  if (!when) return true;
  for (const key of Object.keys(when) as (keyof RuleWhen)[]) {
    const allowed = when[key];
    if (allowed && !allowed.includes(env.dataset(key) ?? "")) return false;
  }
  return true;
}

// "선 없음" 판정: 폭 0 또는 style none(색은 무관 — transparent 1px 도 위반:
// 레이아웃을 점유하는 보이지 않는 선은 R3 모델을 오염시킨다).
function isNoLine(e: EdgeProbe): boolean {
  return e.width === "0px" || e.style === "none";
}

function checkEdge(
  e: EdgeProbe,
  expect: EdgeExpect,
  env: ValidateEnv,
): string | null {
  if (expect === "none") {
    return isNoLine(e) ? null : `선 존재(${e.width} ${e.style} ${e.color})`;
  }
  const want = env.resolveToken(expect);
  if (e.width !== "1px") return `폭 ${e.width}(기대 1px ${expect})`;
  if (e.style !== "solid") return `style ${e.style}(기대 solid)`;
  if (norm(e.color) !== norm(want)) {
    return `색 ${e.color}(기대 ${expect}=${want})`;
  }
  return null;
}

function checkSeam(
  el: ElementProbe,
  seam: NonNullable<BorderRule["seam"]>,
  env: ValidateEnv,
): string | null {
  if (seam === "rest-transparent") {
    const bgClear =
      norm(el.backgroundColor) === "rgba(0,0,0,0)" ||
      norm(el.backgroundColor) === "transparent";
    const noImage = el.backgroundImage === "none";
    return bgClear && noImage
      ? null
      : `휴면 비투명(bg=${el.backgroundColor}, image=${el.backgroundImage})`;
  }
  // "bd-soft": 1px 중앙선 — 배경 그라데이션에 토큰 색 존재.
  const want = norm(env.resolveToken("bd-soft"));
  return norm(el.backgroundImage).includes(want)
    ? null
    : `중앙선 부재(image=${el.backgroundImage}, 기대색 ${want})`;
}

export function evaluateRules(
  rules: readonly BorderRule[],
  env: ValidateEnv,
): ValidateResult {
  const violations: Violation[] = [];
  let rulesActive = 0;
  let elementsChecked = 0;

  for (const rule of rules) {
    if (!whenActive(rule.when, env)) continue;
    rulesActive++;
    const els = env.queryAll(rule.selector);
    els.forEach((el, index) => {
      if (!el.visible) return; // 숨김 요소는 판정 제외(keep-alive 스택 등)
      elementsChecked++;
      if (rule.kind === "seam" && rule.seam) {
        const err = checkSeam(el, rule.seam, env);
        if (err) {
          violations.push({
            rule: rule.id,
            selector: rule.selector,
            index,
            edge: "seam",
            expected: rule.seam,
            actual: err,
          });
        }
        return;
      }
      for (const edge of EDGE_NAMES) {
        const expect = rule.edges?.[edge];
        if (!expect) continue;
        const err = checkEdge(el.edges[edge], expect, env);
        if (err) {
          violations.push({
            rule: rule.id,
            selector: rule.selector,
            index,
            edge,
            expected: expect,
            actual: err,
          });
        }
      }
    });
  }
  return {
    pass: violations.length === 0,
    rulesActive,
    elementsChecked,
    violations,
  };
}

// ── DOM 바인딩 ───────────────────────────────────────────────────────────────

const DATASET_ATTR: Record<keyof RuleWhen, string> = {
  paneStyle: "paneStyle",
  divider: "divider",
};

function probeElement(el: Element): ElementProbe {
  const cs = getComputedStyle(el);
  const edge = (name: string): EdgeProbe => ({
    width: cs.getPropertyValue(`border-${name}-width`),
    style: cs.getPropertyValue(`border-${name}-style`),
    color: cs.getPropertyValue(`border-${name}-color`),
  });
  return {
    edges: {
      top: edge("top"),
      right: edge("right"),
      bottom: edge("bottom"),
      left: edge("left"),
    },
    backgroundColor: cs.backgroundColor,
    backgroundImage: cs.backgroundImage,
    // 닫힌 사이드바(폭 0) 같은 zero-area 요소는 계약 판정 대상이 아니다 —
    // 칠해질 픽셀이 없으므로 "가시"가 아니다.
    visible: (() => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })(),
  };
}

export function domEnv(): ValidateEnv {
  const tokenCache = new Map<string, string>();
  return {
    queryAll: (selector) =>
      [...document.querySelectorAll(selector)].map(probeElement),
    dataset: (name) =>
      (document.documentElement.dataset as Record<string, string | undefined>)[
        DATASET_ATTR[name]
      ],
    // var() 원문은 color-mix 등 미해석 문자열일 수 있다 — 프로브 요소의
    // computed 값으로 정규화된 rgb() 를 얻는다.
    resolveToken: (token) => {
      const hit = tokenCache.get(token);
      if (hit) return hit;
      const probe = document.createElement("div");
      probe.style.borderTopStyle = "solid";
      probe.style.borderTopColor = `var(--${token})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).borderTopColor;
      probe.remove();
      tokenCache.set(token, color);
      return color;
    },
  };
}

// ui.validate 진입점: ruleFilter 는 규칙 id/selector 부분 일치 필터.
export function validateDom(ruleFilter?: string): ValidateResult {
  const rules = ruleFilter
    ? BORDER_RULES.filter(
        (r) => r.id.includes(ruleFilter) || r.selector.includes(ruleFilter),
      )
    : BORDER_RULES;
  return evaluateRules(rules, domEnv());
}

// ui.expect 진입점: 셀렉터가 가리키는 DOM 에 "어느 변이 어때야 하는가"를 알려준다.
// 계약에 없는 셀렉터면 rules: [] — "규칙 없음"도 답이다(추가가 필요하면 계약에).
export function expectForSelector(selector: string): {
  matchedElements: number;
  rules: {
    id: string;
    active: boolean;
    kind: BorderRule["kind"];
    edges?: BorderRule["edges"];
    seam?: BorderRule["seam"];
    note: string;
  }[];
} {
  const env = domEnv();
  const targets = new Set(document.querySelectorAll(selector));
  const rules = BORDER_RULES.filter((r) =>
    [...document.querySelectorAll(r.selector)].some((el) => targets.has(el)),
  ).map((r) => ({
    id: r.id,
    active: whenActive(r.when, env),
    kind: r.kind,
    edges: r.edges,
    seam: r.seam,
    note: r.note,
  }));
  return { matchedElements: targets.size, rules };
}
