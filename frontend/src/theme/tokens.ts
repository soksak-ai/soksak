// A theme is data, and these names are the contract between that data and every
// rule that paints.
//
// Components consume slots, never values. That is what makes a new theme one
// JSON document instead of an edit to every stylesheet — and it only holds if
// the discipline starts before the stylesheet grows.
//
// This file is the one place a literal colour belongs, because defining what a
// colour token means is exactly its job. A gate keeps them out of everywhere else.

/** The twelve colour slots. A theme fills all of them; a partial theme is not a theme. */
export const COLOR_SLOTS = [
  "bg", "card", "side", "inset",
  "fg", "fg2", "fg3", "bd",
  "acc", "accbg", "ok", "shadow",
] as const;

export type ColorSlot = (typeof COLOR_SLOTS)[number];

/** Optional atmosphere. Always defaulted, never required of a theme author. */
export const EFFECT_SLOTS = ["glow", "scan", "amb"] as const;

export type EffectSlot = (typeof EFFECT_SLOTS)[number];

/**
 * Structure, not colour: the shapes a theme chooses.
 *
 * These reach the document as `data-*` attributes rather than variables,
 * because a rule selects on them (`[data-pane-style="card"] .panel`) instead of
 * interpolating them.
 */
export const CHROME_SLOTS = [
  "titlebar", "tabBar", "tabShape", "paneStyle",
  "panePad", "gutter", "statusBg", "font",
] as const;

export type ChromeSlot = (typeof CHROME_SLOTS)[number];

export type ThemeMode = "light" | "dark";

export type ThemeColors = Record<ColorSlot, string>;

export interface ThemeChrome {
  titlebar: "side" | "gradient" | "transparent";
  tabBar: "side" | "transparent";
  tabShape: "chip" | "pill" | "underline" | "inverse" | "round";
  paneStyle: "flat" | "card" | "floating";
  /** A CSS length. */
  panePad: string;
  gutter: "overlay" | "solid";
  statusBg: "side" | "transparent" | "inset";
  font: "system" | "mono";
}

export interface ThemeEffects {
  /** A text-shadow value, or none. */
  glow: string;
  /** Scanline opacity, 0 to 1. */
  scan: number;
  /** A secondary accent. Defaults to the primary one. */
  amb: string | null;
}

export interface Theme {
  readonly name: string;
  readonly defaultMode: ThemeMode;
  readonly colors: ThemeColors;
  /** The other mode. A theme carries both so switching never re-derives colours. */
  readonly colorsAlt: ThemeColors;
  readonly chrome: ThemeChrome;
  readonly effects: ThemeEffects;
}

/** The theme this build starts in. One is enough until themes arrive as data. */
export const DEFAULT_THEME: Theme = {
  name: "Midnight",
  defaultMode: "dark",
  colors: {
    bg: "#080a0d",
    card: "#0b0d10",
    side: "#15181d",
    inset: "#20242a",
    fg: "#d7e0ea",
    fg2: "#aab3bf",
    fg3: "#7d8795",
    bd: "#2b3038",
    acc: "#ff9f6e",
    accbg: "#331e17",
    ok: "#48c781",
    shadow: "0 24px 60px rgba(0, 0, 0, .5)",
  },
  colorsAlt: {
    bg: "#f5f5f7",
    card: "#ffffff",
    side: "#ededf0",
    inset: "#e3e3e8",
    fg: "#1a1a1c",
    fg2: "#5c5c64",
    fg3: "#8a8a93",
    bd: "#d5d5db",
    acc: "#c2410c",
    accbg: "#ffedd5",
    ok: "#1f9d55",
    shadow: "0 24px 60px rgba(20, 20, 30, .16)",
  },
  chrome: {
    titlebar: "side",
    tabBar: "side",
    tabShape: "chip",
    paneStyle: "card",
    panePad: "5px",
    gutter: "solid",
    statusBg: "side",
    font: "system",
  },
  effects: { glow: "none", scan: 0, amb: null },
};

/**
 * Paint a theme onto the document and return the mode that took effect.
 *
 * Plugins learn that colours changed from `data-theme-epoch` and from nothing
 * else. Colours arrive as inline custom properties, so a plugin watching the
 * whole `style` attribute would also wake for zoom and every other unrelated
 * change — in an earlier build that coupling made each font change reflow and
 * re-rasterise every terminal at once. One counter separates the two.
 */
export function applyTheme(theme: Theme, mode: ThemeMode = theme.defaultMode, root: HTMLElement = document.documentElement): ThemeMode {
  const colors = mode === theme.defaultMode ? theme.colors : theme.colorsAlt;
  const style = root.style;

  for (const slot of COLOR_SLOTS) style.setProperty(`--${slot}`, colors[slot]);
  style.setProperty("--glow", theme.effects.glow);
  style.setProperty("--scan", String(theme.effects.scan));
  style.setProperty("--amb", theme.effects.amb ?? colors.acc);
  style.setProperty("--pane-pad", theme.chrome.panePad);

  root.dataset.themeMode = mode;
  root.dataset.titlebar = theme.chrome.titlebar;
  root.dataset.tabBar = theme.chrome.tabBar;
  root.dataset.tabShape = theme.chrome.tabShape;
  root.dataset.paneStyle = theme.chrome.paneStyle;
  root.dataset.gutter = theme.chrome.gutter;
  root.dataset.statusBg = theme.chrome.statusBg;
  root.dataset.chromeFont = theme.chrome.font;

  root.dataset.themeEpoch = String(Number(root.dataset.themeEpoch ?? "0") + 1);
  return mode;
}
