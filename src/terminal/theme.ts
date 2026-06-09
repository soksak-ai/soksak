import type { ITheme } from "@xterm/xterm";

export type ThemeMode = "dark" | "light";

// xterm 테마 background 는 불투명 색을 쓰고, 테마 전환 시 갱신한다
// (투명+WebGL 은 그리드가 검정으로 렌더돼 동작하지 않음). 그리드 잔여(우/하단)는
// CSS --bg 가 칠하므로 backgrounds[] 와 테마 background 를 같은 값으로 맞춘다.
export const backgrounds: Record<ThemeMode, string> = {
  dark: "#1e1e1e",
  light: "#ffffff",
};

// 다크 — 16 ANSI + foreground/cursor/selection.
export const darkTheme: ITheme = {
  foreground: "#cccccc",
  background: backgrounds.dark,
  cursor: "#ffffff",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  selectionInactiveBackground: "#3a3d41",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

// 라이트 — 흰 배경에서 가독성 있는 팔레트.
export const lightTheme: ITheme = {
  foreground: "#333333",
  background: backgrounds.light,
  cursor: "#000000",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  selectionInactiveBackground: "#e5ebf1",
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

export const themes: Record<ThemeMode, ITheme> = {
  dark: darkTheme,
  light: lightTheme,
};

// #RRGGBB 의 상대 휘도(BT.709, r/g/b 를 [0,1] 로). Claude Code 의 OSC 11 감지와 동일식.
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 임의 배경색 → 밝기로 라이트/다크 팔레트를 고르고 background 만 그 색으로 덮는다.
// (글자/ANSI 는 가독성 위해 팔레트 유지, 배경만 사용자 지정.)
export function themeForBg(hex: string): ITheme {
  const base = luminance(hex) > 0.5 ? lightTheme : darkTheme;
  return { ...base, background: hex };
}
