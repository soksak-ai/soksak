// Theme engine — implements soksak-theme-spec v1.
// Principle (spec): components consume token slots only. Adding a theme = 1 token JSON (no code change).
// A theme is assumed to be authored outside, like a plugin (~/.soksak/themes/*.json) — so loading always
// validates and a bad theme is rejected (no partial themes).
//
// Mapping: color tokens → CSS variables (--bg …), structure tokens (chrome) → data-* attributes + CSS
// variables, effects → --glow/--scan. Mode (light/dark) swaps the color layer only and keeps chrome.

export type ThemeMode = "light" | "dark";

// Color tokens (spec §1). Required — a missing slot rejects the load.
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

// Structure tokens (spec §2). Required.
export interface ThemeChrome {
  titlebar: "side" | "gradient" | "transparent";
  tabBar: "side" | "transparent";
  tabShape: "chip" | "pill" | "underline" | "inverse" | "round";
  paneStyle: "flat" | "card" | "floating";
  panePad: string;
  gutter: "overlay" | "solid";
  statusBg: "side" | "transparent" | "inset";
  font: "system" | "mono";
}

const CHROME_ENUM: Record<keyof ThemeChrome, readonly string[] | null> = {
  titlebar: ["side", "gradient", "transparent"],
  tabBar: ["side", "transparent"],
  tabShape: ["chip", "pill", "underline", "inverse", "round"],
  paneStyle: ["flat", "card", "floating"],
  panePad: null, // CSS length string
  gutter: ["overlay", "solid"],
  statusBg: ["side", "transparent", "inset"],
  font: ["system", "mono"],
};

// Effect tokens (spec §1 optional slots) — always fall back to defaults.
export interface ThemeEffects {
  glow: string | null; // Text glow (css text-shadow value), default none
  scanlines: number; // Scanline opacity 0..1, default 0
  amb: string | null; // Secondary accent
}

// The relation surface between the rail and the bound panel. Colors may reference CSS variables so they follow
// the light/dark color layer automatically, and numbers that change geometry are validated as bounded px values.
// An old v1 theme is promoted to this complete default only when the whole relation block is absent.
export interface ThemeRelation {
  stroke: string;
  fill: string;
  strokeWidth: number;
  radius: number;
  label: "badge" | "none";
}

// Feature toolbar row (optional surface) tokens — the theme owns the values. A feature that uses the toolbar
// must consume these variables (--toolbar-h/--toolbar-pad-x); a feature that does not omits the row entirely.
export interface ThemeToolbar {
  height: number; // px, 20..48
  padX: number; // px, 0..24
}

export const DEFAULT_THEME_TOOLBAR: Readonly<ThemeToolbar> = Object.freeze({
  height: 28,
  padX: 8,
});

export const DEFAULT_THEME_RELATION: Readonly<ThemeRelation> = Object.freeze({
  stroke: "var(--acc)",
  fill: "color-mix(in srgb, var(--acc) 7%, transparent)",
  strokeWidth: 1,
  radius: 10,
  label: "badge",
});

export interface ThemeSpec {
  name: string;
  defaultMode: ThemeMode;
  colors: ThemeColors; // Colors of defaultMode
  colorsAlt?: ThemeColors; // The opposite mode (absent = a mode-fixed theme)
  chrome: ThemeChrome;
  effects: ThemeEffects;
  relation: ThemeRelation;
  toolbar: ThemeToolbar;
  // Source (builtin or external file path) — no effect on behavior (for display).
  source: "builtin" | string;
}

export interface ThemeValidation {
  ok: boolean;
  errors: string[]; // Rejection reasons (spec §5-1: no partial themes)
  warnings: string[]; // Contrast below the bar and the like (spec §5-2)
}

// ── Validation ───────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// #rgb/#rrggbb → relative luminance (WCAG). rgba(), gradients and the like skip the check (null).
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
    errors.push(`${label}: not an object`);
    return;
  }
  for (const slot of COLOR_SLOTS) {
    if (typeof v[slot] !== "string" || !(v[slot] as string).trim()) {
      errors.push(`${label}.${slot}: required color slot missing`);
    }
  }
  if (errors.length > 0) return;
  const c = v as unknown as ThemeColors;
  // Spec: fg2 ≥ 4.5:1, fg3 ≥ 3:1 (against bg) — warn when below.
  const r2 = contrastRatio(c.fg2, c.bg);
  if (r2 !== null && r2 < 4.5) {
    warnings.push(`${label}.fg2 contrast ${r2.toFixed(2)}:1 < 4.5:1 (below WCAG)`);
  }
  const r3 = contrastRatio(c.fg3, c.bg);
  if (r3 !== null && r3 < 3) {
    warnings.push(`${label}.fg3 contrast ${r3.toFixed(2)}:1 < 3:1 (below WCAG)`);
  }
}

function parseToolbar(value: unknown, errors: string[]): ThemeToolbar {
  if (value === undefined) return { ...DEFAULT_THEME_TOOLBAR };
  if (!isRecord(value)) {
    errors.push("toolbar: not an object");
    return { ...DEFAULT_THEME_TOOLBAR };
  }
  if (typeof value.height !== "number" || value.height < 20 || value.height > 48) {
    errors.push("toolbar.height: must be a number in 20..48");
  }
  if (typeof value.padX !== "number" || value.padX < 0 || value.padX > 24) {
    errors.push("toolbar.padX: must be a number in 0..24");
  }
  return {
    height:
      typeof value.height === "number" ? value.height : DEFAULT_THEME_TOOLBAR.height,
    padX: typeof value.padX === "number" ? value.padX : DEFAULT_THEME_TOOLBAR.padX,
  };
}

function parseRelation(
  value: unknown,
  errors: string[],
): ThemeRelation {
  if (value === undefined) return { ...DEFAULT_THEME_RELATION };
  if (!isRecord(value)) {
    errors.push("relation: not an object");
    return { ...DEFAULT_THEME_RELATION };
  }
  for (const slot of ["stroke", "fill"] as const) {
    if (typeof value[slot] !== "string" || !value[slot].trim()) {
      errors.push(`relation.${slot}: required CSS color missing`);
    }
  }
  if (
    typeof value.strokeWidth !== "number" ||
    value.strokeWidth < 0.5 ||
    value.strokeWidth > 4
  ) {
    errors.push("relation.strokeWidth: must be a number in 0.5..4");
  }
  if (
    typeof value.radius !== "number" ||
    value.radius < 0 ||
    value.radius > 32
  ) {
    errors.push("relation.radius: must be a number in 0..32");
  }
  if (value.label !== "badge" && value.label !== "none") {
    errors.push("relation.label: must be one of badge|none");
  }
  return {
    stroke: typeof value.stroke === "string" ? value.stroke : DEFAULT_THEME_RELATION.stroke,
    fill: typeof value.fill === "string" ? value.fill : DEFAULT_THEME_RELATION.fill,
    strokeWidth:
      typeof value.strokeWidth === "number"
        ? value.strokeWidth
        : DEFAULT_THEME_RELATION.strokeWidth,
    radius: typeof value.radius === "number" ? value.radius : DEFAULT_THEME_RELATION.radius,
    label:
      value.label === "badge" || value.label === "none"
        ? value.label
        : DEFAULT_THEME_RELATION.label,
  };
}

// External JSON (unknown) → a validated ThemeSpec. On failure the reason goes into errors (no partial themes).
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
    errors.push("theme is not a JSON object");
    return reject();
  }
  // One-time migration of saved themes (identity standard 2026-07-27): chrome.divider (deleted word) → chrome.gutter.
  // Accepted at the load boundary only; every surface after it (stamp, validate, save) uses the new name alone — no two names side by side.
  if (isRecord(raw.chrome) && raw.chrome.gutter === undefined && raw.chrome.divider !== undefined) {
    (raw.chrome as Record<string, unknown>).gutter = raw.chrome.divider;
    delete (raw.chrome as Record<string, unknown>).divider;
  }
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    errors.push("name: required");
  }
  if (raw.defaultMode !== "light" && raw.defaultMode !== "dark") {
    errors.push('defaultMode: "light" | "dark" required');
  }
  validateColors(raw.colors, "colors", errors, warnings);
  if (raw.colorsAlt !== undefined) {
    validateColors(raw.colorsAlt, "colorsAlt", errors, warnings);
  }

  if (!isRecord(raw.chrome)) {
    errors.push("chrome: required object");
  } else {
    for (const [slot, allowed] of Object.entries(CHROME_ENUM)) {
      const v = raw.chrome[slot];
      if (typeof v !== "string" || !v.trim()) {
        errors.push(`chrome.${slot}: required slot missing`);
      } else if (allowed && !allowed.includes(v)) {
        errors.push(`chrome.${slot}: must be one of ${allowed.join("|")}`);
      }
    }
  }

  // Effects: undeclared falls back to defaults (spec §5-3) — not an error.
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
  const relation = parseRelation(raw.relation, errors);
  const toolbar = parseToolbar(raw.toolbar, errors);

  // Border guarantee invariant (UI constitution §B1: a panel border always exists) — reject a token combination
  // that removes the border: flat (no frame) requires gutter "solid" (an always-present seam line).
  if (isRecord(raw.chrome)) {
    if (raw.chrome.paneStyle === "flat" && raw.chrome.gutter !== "solid") {
      errors.push(
        'border guarantee (§B1): paneStyle "flat" requires gutter "solid" — with no frame, an overlay gutter removes the pane boundary',
      );
    }
  }

  if (errors.length > 0) return reject();
  return {
    theme: {
      name: (raw.name as string).trim(),
      defaultMode: raw.defaultMode as ThemeMode,
      colors: raw.colors as unknown as ThemeColors,
      colorsAlt: raw.colorsAlt as unknown as ThemeColors | undefined,
      chrome: raw.chrome as unknown as ThemeChrome,
      effects,
      relation,
      toolbar,
      source,
    },
    validation: { ok: true, errors, warnings },
  };
}

// The color layer of a mode the theme supports. A request for an unsupported mode falls back to the default mode.
export function colorsForMode(
  theme: ThemeSpec,
  mode: ThemeMode,
): { colors: ThemeColors; mode: ThemeMode } {
  if (mode === theme.defaultMode) return { colors: theme.colors, mode };
  if (theme.colorsAlt) return { colors: theme.colorsAlt, mode };
  return { colors: theme.colors, mode: theme.defaultMode };
}

// ── Apply (slots → CSS variables and attributes) ─────────────────────────────

// Native window background = theme bg (layer principle): the root DOM background is transparent (App.css), so
// the window background is responsible for the color of unpainted areas — it must always match the theme.
// Outside the Tauri runtime (test jsdom) it is silently ignored.
function syncWindowBackground(bg: string): void {
  void import("../framework")
    .then(({ invoke }) => invoke("window_set_background", { color: bg }))
    .catch(() => {});
}

export function applyThemeToDom(theme: ThemeSpec, mode: ThemeMode): ThemeMode {
  const { colors, mode: effective } = colorsForMode(theme, mode);
  const root = document.documentElement;
  const s = root.style;
  for (const slot of COLOR_SLOTS) {
    s.setProperty(`--${slot}`, colors[slot]);
  }
  syncWindowBackground(colors.bg);
  s.setProperty("--glow", theme.effects.glow ?? "none");
  s.setProperty("--scan", String(theme.effects.scanlines));
  s.setProperty("--amb", theme.effects.amb ?? colors.acc);
  s.setProperty("--toolbar-h", `${theme.toolbar.height}px`);
  s.setProperty("--toolbar-pad-x", `${theme.toolbar.padX}px`);
  s.setProperty("--relation-stroke", theme.relation.stroke);
  s.setProperty("--relation-fill", theme.relation.fill);
  s.setProperty("--relation-stroke-w", `${theme.relation.strokeWidth}px`);
  s.setProperty("--relation-radius", `${theme.relation.radius}px`);
  s.setProperty("--pane-pad", theme.chrome.panePad);
  root.dataset.themeMode = effective;
  root.dataset.tabShape = theme.chrome.tabShape;
  root.dataset.paneStyle = theme.chrome.paneStyle;
  root.dataset.titlebar = theme.chrome.titlebar;
  root.dataset.tabBar = theme.chrome.tabBar;
  root.dataset.statusBg = theme.chrome.statusBg;
  root.dataset.gutter = theme.chrome.gutter;
  root.dataset.chromeFont = theme.chrome.font;
  root.dataset.relationLabel = theme.relation.label;
  // [PERF RULE] Single theme-change signal — this one attribute is the plugin's (terminal's) only cue for when to
  // reapply color tokens. Colors go in through `style` (setProperty of --bg and friends), but a plugin observing
  // all of `style` makes every terminal reflow + clearTextureAtlas + refresh on theme-unrelated style mutations
  // such as ⌘± (--app-font-size) (coupling → CPU storm). So each real theme apply raises epoch by 1 and the
  // plugin observes data-theme-epoch alone (separated from font changes).
  const epoch = Number(root.dataset.themeEpoch ?? "0") + 1;
  root.dataset.themeEpoch = String(epoch);
  return effective;
}
