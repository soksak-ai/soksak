// 테마 엔진 — soksak-theme-spec v1 구현.
// 원칙(스펙): 컴포넌트는 토큰 슬롯만 소비한다. 새 테마 추가 = 토큰 JSON 1개(코드 수정
// 없음). 테마는 플러그인처럼 외부(~/.soksak/themes/*.json)에서 만들어져 들어온다고
// 가정한다 — 그래서 로드는 항상 검증을 거치고, 불량 테마는 거부된다(부분 테마 금지).
//
// 매핑: 색 토큰 → CSS 변수(--bg …), 구조 토큰(chrome) → data-* 속성 + CSS 변수,
// 효과 → --glow/--scan. 모드(light/dark)는 색 레이어만 바꾸고 chrome 은 유지.

export type ThemeMode = "light" | "dark";

// 색 토큰(스펙 §1). 필수 — 누락 시 로드 거부.
export interface ThemeColors {
  bg: string;
  card: string;
  side: string;
  inset: string;
  fg: string;
  fg2: string;
  fg3: string;
  bd: string;
  acc: string;
  accbg: string;
  ok: string;
  shadow: string;
}

export const COLOR_SLOTS: readonly (keyof ThemeColors)[] = [
  "bg",
  "card",
  "side",
  "inset",
  "fg",
  "fg2",
  "fg3",
  "bd",
  "acc",
  "accbg",
  "ok",
  "shadow",
];

// 구조 토큰(스펙 §2). 필수.
export interface ThemeChrome {
  titlebar: "side" | "gradient" | "transparent";
  tabBar: "side" | "transparent";
  tabShape: "chip" | "pill" | "underline" | "inverse" | "round";
  paneStyle: "flat" | "card" | "floating";
  panePad: string;
  divider: "overlay" | "solid";
  statusBg: "side" | "transparent" | "inset";
  font: "system" | "mono";
}

const CHROME_ENUM: Record<keyof ThemeChrome, readonly string[] | null> = {
  titlebar: ["side", "gradient", "transparent"],
  tabBar: ["side", "transparent"],
  tabShape: ["chip", "pill", "underline", "inverse", "round"],
  paneStyle: ["flat", "card", "floating"],
  panePad: null, // CSS 길이 문자열
  divider: ["overlay", "solid"],
  statusBg: ["side", "transparent", "inset"],
  font: ["system", "mono"],
};

// 효과 토큰(스펙 §1 선택 슬롯) — 항상 기본값 폴백.
export interface ThemeEffects {
  glow: string | null; // 텍스트 글로우(css text-shadow 값), 기본 none
  scanlines: number; // 스캔라인 불투명도 0~1, 기본 0
  amb: string | null; // 보조 액센트
}

export interface ThemeSpec {
  name: string;
  defaultMode: ThemeMode;
  colors: ThemeColors; // defaultMode 의 색
  colorsAlt?: ThemeColors; // 반대 모드(없으면 모드 고정 테마)
  chrome: ThemeChrome;
  effects: ThemeEffects;
  // 출처(내장/외부 파일 경로) — 동작엔 영향 없음(표시용).
  source: "builtin" | string;
}

export interface ThemeValidation {
  ok: boolean;
  errors: string[]; // 거부 사유(스펙 §5-1: 부분 테마 금지)
  warnings: string[]; // 대비 미달 등(스펙 §5-2)
}

// ── 검증 ─────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// #rgb/#rrggbb → 상대 휘도(WCAG). rgba()/그라데이션 등은 검사 생략(null).
function luminanceOf(color: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * lin((n >> 16) & 255) +
    0.7152 * lin((n >> 8) & 255) +
    0.0722 * lin(n & 255)
  );
}

function contrastRatio(a: string, b: string): number | null {
  const la = luminanceOf(a);
  const lb = luminanceOf(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function validateColors(
  v: unknown,
  label: string,
  errors: string[],
  warnings: string[],
): void {
  if (!isRecord(v)) {
    errors.push(`${label}: 객체가 아님`);
    return;
  }
  for (const slot of COLOR_SLOTS) {
    if (typeof v[slot] !== "string" || !(v[slot] as string).trim()) {
      errors.push(`${label}.${slot}: 필수 색 슬롯 누락`);
    }
  }
  if (errors.length > 0) return;
  const c = v as unknown as ThemeColors;
  // 스펙: fg2 ≥ 4.5:1, fg3 ≥ 3:1 (bg 기준) — 미달 시 경고.
  const r2 = contrastRatio(c.fg2, c.bg);
  if (r2 !== null && r2 < 4.5) {
    warnings.push(`${label}.fg2 대비 ${r2.toFixed(2)}:1 < 4.5:1 (WCAG 미달)`);
  }
  const r3 = contrastRatio(c.fg3, c.bg);
  if (r3 !== null && r3 < 3) {
    warnings.push(`${label}.fg3 대비 ${r3.toFixed(2)}:1 < 3:1 (WCAG 미달)`);
  }
}

// 외부 JSON(unknown) → 검증된 ThemeSpec. 실패 시 errors 에 사유(부분 테마 금지).
export function parseTheme(
  raw: unknown,
  source: "builtin" | string,
): { theme: ThemeSpec | null; validation: ThemeValidation } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const reject = () => ({
    theme: null,
    validation: { ok: false, errors, warnings },
  });

  if (!isRecord(raw)) {
    errors.push("테마가 JSON 객체가 아님");
    return reject();
  }
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    errors.push("name: 필수");
  }
  if (raw.defaultMode !== "light" && raw.defaultMode !== "dark") {
    errors.push('defaultMode: "light" | "dark" 필수');
  }
  validateColors(raw.colors, "colors", errors, warnings);
  if (raw.colorsAlt !== undefined) {
    validateColors(raw.colorsAlt, "colorsAlt", errors, warnings);
  }

  if (!isRecord(raw.chrome)) {
    errors.push("chrome: 필수 객체");
  } else {
    for (const [slot, allowed] of Object.entries(CHROME_ENUM)) {
      const v = raw.chrome[slot];
      if (typeof v !== "string" || !v.trim()) {
        errors.push(`chrome.${slot}: 필수 슬롯 누락`);
      } else if (allowed && !allowed.includes(v)) {
        errors.push(`chrome.${slot}: ${allowed.join("|")} 중 하나여야 함`);
      }
    }
  }

  // 효과: 미선언 시 기본값 폴백(스펙 §5-3) — 에러 아님.
  const eff = isRecord(raw.effects) ? raw.effects : {};
  const effects: ThemeEffects = {
    glow: typeof eff.glow === "string" ? eff.glow : null,
    scanlines:
      typeof eff.scanlines === "number" &&
      eff.scanlines >= 0 &&
      eff.scanlines <= 1
        ? eff.scanlines
        : 0,
    amb: typeof eff.amb === "string" ? eff.amb : null,
  };

  if (errors.length > 0) return reject();
  return {
    theme: {
      name: (raw.name as string).trim(),
      defaultMode: raw.defaultMode as ThemeMode,
      colors: raw.colors as unknown as ThemeColors,
      colorsAlt: raw.colorsAlt as unknown as ThemeColors | undefined,
      chrome: raw.chrome as unknown as ThemeChrome,
      effects,
      source,
    },
    validation: { ok: true, errors, warnings },
  };
}

// 테마가 지원하는 모드의 색 레이어. 미지원 모드 요청 시 기본 모드로 폴백.
export function colorsForMode(
  theme: ThemeSpec,
  mode: ThemeMode,
): { colors: ThemeColors; mode: ThemeMode } {
  if (mode === theme.defaultMode) return { colors: theme.colors, mode };
  if (theme.colorsAlt) return { colors: theme.colorsAlt, mode };
  return { colors: theme.colors, mode: theme.defaultMode };
}

// ── 적용(슬롯 → CSS 변수/속성) ───────────────────────────────────────────────

export function applyThemeToDom(theme: ThemeSpec, mode: ThemeMode): ThemeMode {
  const { colors, mode: effective } = colorsForMode(theme, mode);
  const root = document.documentElement;
  const s = root.style;
  for (const slot of COLOR_SLOTS) {
    s.setProperty(`--${slot}`, colors[slot]);
  }
  s.setProperty("--glow", theme.effects.glow ?? "none");
  s.setProperty("--scan", String(theme.effects.scanlines));
  s.setProperty("--amb", theme.effects.amb ?? colors.acc);
  s.setProperty("--pane-pad", theme.chrome.panePad);
  root.dataset.themeMode = effective;
  root.dataset.tabShape = theme.chrome.tabShape;
  root.dataset.paneStyle = theme.chrome.paneStyle;
  root.dataset.titlebar = theme.chrome.titlebar;
  root.dataset.tabBar = theme.chrome.tabBar;
  root.dataset.statusBg = theme.chrome.statusBg;
  root.dataset.divider = theme.chrome.divider;
  root.dataset.chromeFont = theme.chrome.font;
  return effective;
}
