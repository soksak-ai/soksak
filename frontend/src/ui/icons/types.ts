// Icon system types. The app uses semantic names (IconName) only. Same single-source rule as
// docs/PERFORMANCE.md: glyphs and sets are data, meaning is code.
// Single source for semantic name to per-set icon mapping is MAPPING in scripts/icons/extract.mjs.

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
  "pin",
  "pin-filled",
  "menu",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "arrow-down",
  "arrow-up-right",
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

// Render mode: stroke (line) / fill (area) / both (line+fill, for sets with no filled variant).
export type IconRenderMode = "stroke" | "fill" | "both";

export interface IconGlyph {
  /** SVG viewBox */
  v: string;
  /** SVG inner markup (trusted source: checked-in extraction output or validated plugin data) */
  b: string;
  /** Render mode */
  f: IconRenderMode;
}

/** Semantic name to glyph. A set must supply every name; a partial set is rejected at registration. */
export type IconSetData = Record<IconName, IconGlyph>;
