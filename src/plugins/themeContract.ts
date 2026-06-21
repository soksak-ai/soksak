// 테마 변수 계약 — 스켈레톤이 플러그인에 보장하는 CSS 커스텀 프로퍼티 집합(단일 진실).
// 출처는 코어 테마 엔진과 App.css 다. 여기서 직접 가져오거나 열거한다(다른 곳에 복제 금지).
// 플러그인 CSS 가 이 집합 밖의 var(--X) 를 참조하면 코어가 그 이름으로 값을 안 주므로 폴백 색만
// 먹고 테마가 적용되지 않는다(조용한 시각 버그). findGhostThemeVars 가 그 부정합을 기계적으로 잡는다.
import { COLOR_SLOTS } from "../theme/engine";

// 엔진이 슬롯 외에 추가로 setProperty 하는 변수(engine.ts applyThemeToDom) + App.tsx.
const ENGINE_EXTRA_VARS = ["glow", "scan", "amb", "pane-pad", "app-font"] as const;

// App.css 가 :root 에 정적 선언하는 변수(레이아웃 치수 포함). 출처: src/App.css.
// 색·폰트뿐 아니라 플러그인이 정당하게 참조할 수 있는 모든 정적 변수를 포함한다.
const STATIC_CSS_VARS = [
  "bd-soft", "danger", "danger-soft",
  "chrome-row-h", "header-h", "status-h", "tab-pad", "ws-pad",
  "fk-bot", "fk-len", "fk-th", "fk-top", "trees-padding-inline-override",
] as const;

// 코어가 보장하는 전체 테마/스타일 변수 이름 집합("--" 접두 제외).
export const CORE_THEME_VARS: ReadonlySet<string> = new Set<string>([
  ...COLOR_SLOTS,
  ...ENGINE_EXTRA_VARS,
  ...STATIC_CSS_VARS,
]);

// 직렬화 가능한 계약(Doctor 가 contract.json 으로 소비 — 코어가 단일 발행).
export function themeVarContract(): string[] {
  return [...CORE_THEME_VARS].sort();
}

// 텍스트(CSS/소스/번들 main.js)에서 참조된 var(--X) 중 계약 밖(유령)인 이름을 정렬해 반환.
// 순수 함수 — 코어 테스트와 Doctor 가 동일 로직으로 재사용한다.
export function findGhostThemeVars(
  text: string,
  contract: ReadonlySet<string> = CORE_THEME_VARS,
): string[] {
  const ghosts = new Set<string>();
  for (const m of text.matchAll(/var\(\s*--([a-z0-9-]+)/g)) {
    if (!contract.has(m[1])) ghosts.add(m[1]);
  }
  return [...ghosts].sort();
}
