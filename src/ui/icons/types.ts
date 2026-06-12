// 아이콘 시스템 타입 — 앱은 시맨틱 이름(IconName)만 사용한다(docs/PERFORMANCE.md
// 의 원칙과 동일한 단일진실 사고: 글리프/셋은 데이터, 의미는 코드).
// 시맨틱 이름 ↔ 셋별 아이콘 매핑의 단일 진실은 scripts/icons/extract.mjs 의 MAPPING.

export const ICON_NAMES = [
  "close",
  "add",
  "minus",
  "refresh",
  "settings",
  "sun",
  "moon",
  "panel-left",
  "panel-right",
  "star",
  "star-filled",
  "menu",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "arrow-down",
  "terminal",
  "file",
  "browser",
  "plugin",
  "dirty",
  "split",
  "grip",
  "chevron-right",
  "none",
  "folder",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

// 렌더 모드: stroke(선) / fill(면) / both(선+채움 — filled 변형이 없는 셋용).
export type IconRenderMode = "stroke" | "fill" | "both";

export interface IconGlyph {
  /** SVG viewBox */
  v: string;
  /** SVG 내부 마크업(신뢰 출처 — 체크인된 추출 생성물/검증된 플러그인 데이터) */
  b: string;
  /** 렌더 모드 */
  f: IconRenderMode;
}

/** 시맨틱 이름 → 글리프. 셋은 전 이름을 제공해야 한다(부분 셋은 등록 거부). */
export type IconSetData = Record<IconName, IconGlyph>;
