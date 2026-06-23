// 테마 변수 계약 — 스켈레톤이 플러그인에 보장하는 CSS 커스텀 프로퍼티 집합(단일 진실).
// 출처는 코어 테마 엔진과 App.css 다. 여기서 직접 가져오거나 열거한다(다른 곳에 복제 금지).
// 플러그인 CSS 가 이 집합 밖의 var(--X) 를 참조하면 코어가 그 이름으로 값을 안 주므로 폴백 색만
// 먹고 테마가 적용되지 않는다(조용한 시각 버그). findGhostThemeVars 가 그 부정합을 기계적으로 잡는다.
import { COLOR_SLOTS } from "../theme/engine";

// 엔진이 슬롯 외에 추가로 setProperty 하는 변수(engine.ts applyThemeToDom) + App.tsx.
const ENGINE_EXTRA_VARS = ["glow", "scan", "amb", "pane-pad", "app-font", "app-font-size"] as const;

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

// 호스트 테마 "의미 어휘" — 플러그인이 코어 토큰으로 기대하고 쓰는(또는 착각해서 쓰는) 시맨틱 이름의 뿌리.
// 유령 판정 범위를 이 어휘로 한정한다: 라이브러리/사적 네임스페이스(radix-*, trees-*, color-blue-500,
// gap …)는 어휘 밖이라 검사하지 않는다(false positive 방지). 어휘 안 이름인데 코어가 안 주면 = 진짜 버그.
// 예: text/surface/accent/border/background/foreground/hover/bg2 → 코어엔 fg/card/acc/bd/bg 만 있음.
const HOST_THEME_VOCAB: ReadonlySet<string> = new Set<string>([
  "bg", "fg", "text", "foreground", "background", "surface", "card", "panel",
  "side", "sidebar", "inset", "bd", "border", "acc", "accent", "accbg", "ok",
  "success", "shadow", "hover", "muted", "primary", "secondary", "danger",
  "warning", "error", "link", "ring", "focus", "selection", "highlight",
]);

// 직렬화 가능한 계약(Doctor 가 contract.json 으로 소비 — 코어가 단일 발행).
export function themeVarContract(): { vars: string[]; vocab: string[] } {
  return {
    vars: [...CORE_THEME_VARS].sort(),
    vocab: [...HOST_THEME_VOCAB].sort(),
  };
}

// 변수 이름의 시맨틱 뿌리 — 끝 숫자/-숫자 제거(bg2→bg, text-2→text, surface-2→surface).
function themeRoot(name: string): string {
  return name.replace(/-?\d+$/, "");
}

// 이름이 호스트 테마 토큰을 의도한 것인지(유령 검사 대상인지).
export function isHostThemeToken(
  name: string,
  vocab: ReadonlySet<string> = HOST_THEME_VOCAB,
): boolean {
  return vocab.has(name) || vocab.has(themeRoot(name));
}

// 텍스트(CSS/소스/번들 main.js)에서 "유령" 변수를 정렬해 반환. 순수 함수 — Doctor 와 동일 로직.
// 유령 = var(--X) 로 참조됐지만 (a) 코어 계약에 없고 (b) 그 텍스트가 스스로 정의(--X:)하지도 않고
// (c) 호스트 테마 의미 어휘에 속하는 이름 — 즉 "코어 토큰을 의도했는데 코어가 안 주는" 것.
// 자체 정의 변수(Tailwind/Radix/@pierre-trees 등 라이브러리·사적 토큰)는 유령이 아니다.
export function findGhostThemeVars(
  text: string,
  contract: ReadonlySet<string> = CORE_THEME_VARS,
): string[] {
  const defined = new Set<string>();
  for (const m of text.matchAll(/--([a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  const ghosts = new Set<string>();
  for (const m of text.matchAll(/var\(\s*--([a-z0-9-]+)/g)) {
    const v = m[1];
    if (!contract.has(v) && !defined.has(v) && isHostThemeToken(v)) ghosts.add(v);
  }
  return [...ghosts].sort();
}
