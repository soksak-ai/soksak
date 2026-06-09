import type { ITheme } from "@xterm/xterm";

// 다크 테마 — 16 ANSI + foreground/background/cursor/selection.
// editor getXtermTheme 구조를 따른다(테마 토글은 Phase 4 에서 확장).
export const darkTheme: ITheme = {
  foreground: "#cccccc",
  background: "#1e1e1e",
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
