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
