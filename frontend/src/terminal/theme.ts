import type { ITheme } from "@xterm/xterm";

export type ThemeMode = "dark" | "light";

// The xterm theme background uses an opaque color and is updated on theme switch
// (transparent + WebGL does not work — the grid renders black). CSS --bg paints the
// grid remainder (right/bottom), so backgrounds[] and the theme background are kept equal.
export const backgrounds: Record<ThemeMode, string> = {
  dark: "#1e1e1e",
  light: "#ffffff",
};

// Dark — 16 ANSI + foreground/cursor/selection.
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

// Light — palette readable on a white background.
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

// Relative luminance of #RRGGBB (BT.709, r/g/b scaled to [0,1]). Same formula as Claude Code's OSC 11 detection.
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Arbitrary background color → pick the light/dark palette by brightness and override only background
// with that color. (Text/ANSI keep the palette for readability; only the background is user-specified.)
export function themeForBg(hex: string): ITheme {
  const base = luminance(hex) > 0.5 ? lightTheme : darkTheme;
  return { ...base, background: hex };
}
