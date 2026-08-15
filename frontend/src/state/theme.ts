import { invoke, currentWindow, titlebarComposition } from "../framework";
import { recordTitlebarProvisionBreach } from "../framework/titlebarProvision";
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";
import {
  applyThemeToDom,
  colorsForMode,
  parseTheme,
  type ThemeColors,
  type ThemeMode,
  type ThemeSpec,
} from "../theme/engine";
import { BUILTIN_THEMES } from "../theme/builtin";

// Theme store — loads builtin and external (~/.soksak/themes/*.json) themes with the same
// validation and persists the selection (name/mode). The engine (applyThemeToDom) applies it as
// CSS variables and attributes.

interface RejectedTheme {
  file: string;
  errors: string[];
}

interface ThemeState {
  themes: Record<string, ThemeSpec>;
  rejected: RejectedTheme[]; // external themes that failed validation, with the reason
  warnings: Record<string, string[]>; // per-theme warnings (contrast below the floor and such)
  current: string;
  mode: ThemeMode; // requested mode (falls back to effectiveMode when the theme lacks it)
  effectiveMode: ThemeMode;
  colors: ThemeColors; // color layer currently applied (for component subscriptions)
  spec: ThemeSpec; // current theme
  // Load external themes (boot/rescan). Includes re-applying the current theme.
  reload: () => Promise<void>;
  apply: (name: string, mode?: ThemeMode) => boolean;
  // Apply the authoritative (app.data) selection — no save (prevents cross-window save ping-pong).
  // coreSync only.
  applyPersisted: (sel: { name: string; mode?: ThemeMode }) => void;
  toggleMode: () => void;
  install: (path: string) => Promise<string>;
}

const KEY = "soksak.theme";
const FALLBACK = "Cupertino"; // spec §5-1 fallback
const DEFAULT_THEME = "Midnight"; // app default (keeps the existing dark experience)

function loadBuiltins(): {
  themes: Record<string, ThemeSpec>;
  warnings: Record<string, string[]>;
} {
  const themes: Record<string, ThemeSpec> = {};
  const warnings: Record<string, string[]> = {};
  for (const raw of BUILTIN_THEMES) {
    const { theme, validation } = parseTheme(raw, "builtin");
    if (theme) {
      themes[theme.name] = theme;
      if (validation.warnings.length) warnings[theme.name] = validation.warnings;
    } else {
      // Builtin themes are validated in the repository, so reaching here is a bug — report it loudly.
      console.error("builtin theme failed validation:", validation.errors);
    }
  }
  return { themes, warnings };
}

// Native chrome (traffic lights) theme sync — two channels:
//   1) Window NSAppearance follows the app theme mode (setTheme) — the inactive grey dots are
//      drawn against the window appearance, so a mismatch such as system dark + app light
//      theme buries them in a bright background (and the reverse).
//   2) Opaque backing color behind the buttons (titlebar_backing) — the inactive widget's
//      backdrop composition cannot sample the webview layer and becomes a ghost, so a
//      theme-colored backing is laid under it.
//
// The second channel does not branch on framework name. **It reads the declaration**
// (titlebarComposition): a framework that declares no backing plane is not called, and a rejection
// from a framework that declares one is a split between declaration and behavior — record it in
// the ledger instead of swallowing it.
function syncTitlebarBacking(theme: ThemeSpec, mode: ThemeMode): void {
  try {
    void currentWindow()
      .setTheme(mode)
      .catch(() => {
        // Unsupported platform or missing permission — ignore (no effect on theme token render).
      });
    // What declares itself absent is not called. The reason is in the declaration and diagnostics
    // read it (framework.info).
    if (!titlebarComposition.backingPlane.provided) return;
    const { colors } = colorsForMode(theme, mode);
    const hex = theme.chrome.titlebar === "side" ? colors.side : colors.bg;
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return;
    const n = parseInt(m[1], 16);
    void invoke("titlebar_backing", {
      r: ((n >> 16) & 255) / 255,
      g: ((n >> 8) & 255) / 255,
      b: (n & 255) / 255,
    }).catch((error: unknown) => {
      // Declared present, then rejected — swallowing it hides "declared, screen unchanged" forever.
      recordTitlebarProvisionBreach("backingPlane", "titlebar_backing", error);
    });
  } catch {
    // No framework runtime (jsdom tests and such) — the adapter throws synchronously.
    // No native chrome in this environment, so the sync itself is meaningless: pass silently.
  }
}

// Theme selection (name/mode) persistence — app.data authority + ls sync cache (coreSync). init at boot.
type ThemeSel = { name: string; mode?: ThemeMode };
const themeSync = createCoreSync<ThemeSel>({
  key: "theme",
  lsKey: KEY,
  fallback: { name: DEFAULT_THEME },
  // Authoritative value arrives (hydrate / another window) → apply without saving.
  apply: (sel) => useTheme.getState().applyPersisted(sel),
});
export const initThemePersistence = (deps: CoreStoreDeps): (() => void) =>
  themeSync.init(deps);

function loadSelection(): ThemeSel {
  return themeSync.loadSync();
}

// The store is outside the module boundary — if a hot swap replaces it, registration, subscription
// and screen state all become new, and the filling side treats it as already filled and never
// refills it (empty forever).
export const useTheme = moduleState("state/theme#store", () =>
  create<ThemeState>((set, get) => {
  const { themes, warnings } = loadBuiltins();
  const sel = loadSelection();
  const initial =
    themes[sel.name] ?? themes[DEFAULT_THEME] ?? themes[FALLBACK];
  const initialMode = sel.mode ?? initial.defaultMode;
  const effective = applyThemeToDom(initial, initialMode);
  syncTitlebarBacking(initial, effective);

  const persist = () => {
    const s = get();
    themeSync.save({ name: s.current, mode: s.mode });
  };
  // Apply the selection (DOM + state). save=true persists (user action), false mirrors authority
  // (no save).
  const applySel = (name: string, mode: ThemeMode | undefined, save: boolean): boolean => {
    const theme = get().themes[name];
    if (!theme) return false;
    const m = mode ?? get().mode;
    const effectiveMode = applyThemeToDom(theme, m);
    syncTitlebarBacking(theme, effectiveMode);
    set({
      current: name,
      spec: theme,
      mode: m,
      effectiveMode,
      colors: colorsForMode(theme, m).colors,
    });
    if (save) persist();
    return true;
  };

  return {
    themes,
    rejected: [],
    warnings,
    current: initial.name,
    mode: initialMode,
    effectiveMode: effective,
    colors: colorsForMode(initial, initialMode).colors,
    spec: initial,

    reload: async () => {
      const files = await invoke<{ file: string; content: string }[]>(
        "themes_scan",
      );
      const next = loadBuiltins();
      const rejected: RejectedTheme[] = [];
      for (const f of files) {
        let raw: unknown;
        try {
          raw = JSON.parse(f.content);
        } catch (e) {
          rejected.push({ file: f.file, errors: [`JSON parse failed: ${e}`] });
          continue;
        }
        const { theme, validation } = parseTheme(raw, f.file);
        if (theme) {
          next.themes[theme.name] = theme; // an external theme may override a builtin of the same name (plugin model)
          if (validation.warnings.length) {
            next.warnings[theme.name] = validation.warnings;
          }
        } else {
          rejected.push({ file: f.file, errors: validation.errors });
        }
      }
      set({ themes: next.themes, warnings: next.warnings, rejected });
      // Re-apply the current theme (picks up external updates). Fall back if it is gone.
      const s = get();
      const cur = next.themes[s.current] ?? next.themes[FALLBACK];
      get().apply(cur.name, s.mode);
    },

    apply: (name, mode) => applySel(name, mode, true),
    // Mirror authority (no save) — ignore an unknown theme (keep the fallback).
    applyPersisted: (sel) => {
      applySel(sel.name, sel.mode, false);
    },

    toggleMode: () => {
      const s = get();
      const next: ThemeMode = s.effectiveMode === "dark" ? "light" : "dark";
      s.apply(s.current, next);
    },

    install: async (path) => {
      const dst = await invoke<string>("theme_install", { path });
      await get().reload();
      return dst;
    },
  };
}),
);
