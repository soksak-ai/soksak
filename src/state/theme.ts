import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  applyThemeToDom,
  colorsForMode,
  parseTheme,
  type ThemeColors,
  type ThemeMode,
  type ThemeSpec,
} from "../theme/engine";
import { BUILTIN_THEMES } from "../theme/builtin";

// 테마 스토어 — 내장 + 외부(~/.soksak/themes/*.json)를 같은 검증으로 로드하고,
// 선택(이름/모드)을 영속한다. 적용은 엔진(applyThemeToDom)이 CSS 변수/속성으로.

interface RejectedTheme {
  file: string;
  errors: string[];
}

interface ThemeState {
  themes: Record<string, ThemeSpec>;
  rejected: RejectedTheme[]; // 검증 실패한 외부 테마(사유 포함)
  warnings: Record<string, string[]>; // 테마별 경고(대비 미달 등)
  current: string;
  mode: ThemeMode; // 요청 모드(테마가 미지원이면 effectiveMode 로 폴백)
  effectiveMode: ThemeMode;
  colors: ThemeColors; // 현재 적용된 색 레이어(컴포넌트 구독용)
  spec: ThemeSpec; // 현재 테마
  // 외부 테마 로드(시작/재스캔). 현재 테마 재적용 포함.
  reload: () => Promise<void>;
  apply: (name: string, mode?: ThemeMode) => boolean;
  toggleMode: () => void;
  install: (path: string) => Promise<string>;
}

const KEY = "soksak.theme";
const FALLBACK = "Cupertino"; // 스펙 §5-1 폴백
const DEFAULT_THEME = "Midnight"; // 앱 기본(기존 다크 경험 유지)

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
      // 내장 테마는 저장소에서 검증되므로 도달하면 버그 — 소리내어 알린다.
      console.error("내장 테마 검증 실패:", validation.errors);
    }
  }
  return { themes, warnings };
}

function loadSelection(): { name: string; mode?: ThemeMode } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // 무시 — 기본값
  }
  return { name: DEFAULT_THEME };
}

export const useTheme = create<ThemeState>((set, get) => {
  const { themes, warnings } = loadBuiltins();
  const sel = loadSelection();
  const initial =
    themes[sel.name] ?? themes[DEFAULT_THEME] ?? themes[FALLBACK];
  const initialMode = sel.mode ?? initial.defaultMode;
  const effective = applyThemeToDom(initial, initialMode);

  const persist = () => {
    const s = get();
    localStorage.setItem(KEY, JSON.stringify({ name: s.current, mode: s.mode }));
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
          rejected.push({ file: f.file, errors: [`JSON 파싱 실패: ${e}`] });
          continue;
        }
        const { theme, validation } = parseTheme(raw, f.file);
        if (theme) {
          next.themes[theme.name] = theme; // 외부가 동명 내장을 덮을 수 있음(플러그인 모델)
          if (validation.warnings.length) {
            next.warnings[theme.name] = validation.warnings;
          }
        } else {
          rejected.push({ file: f.file, errors: validation.errors });
        }
      }
      set({ themes: next.themes, warnings: next.warnings, rejected });
      // 현재 테마 재적용(외부 갱신 반영). 사라졌으면 폴백.
      const s = get();
      const cur = next.themes[s.current] ?? next.themes[FALLBACK];
      get().apply(cur.name, s.mode);
    },

    apply: (name, mode) => {
      const theme = get().themes[name];
      if (!theme) return false;
      const m = mode ?? get().mode;
      const effectiveMode = applyThemeToDom(theme, m);
      set({
        current: name,
        spec: theme,
        mode: m,
        effectiveMode,
        colors: colorsForMode(theme, m).colors,
      });
      persist();
      return true;
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
});
