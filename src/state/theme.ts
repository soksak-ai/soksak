import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  // 권위(app.data) 선택 적용 — 저장하지 않는다(크로스윈도우 save 핑퐁 방지). coreSync 전용.
  applyPersisted: (sel: { name: string; mode?: ThemeMode }) => void;
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

// 네이티브 크롬(macOS 신호등) 테마 동기화 — 두 채널:
//   1) 창 NSAppearance 를 앱 테마 모드로(setTheme) — 비활성 회색 점은 창
//      appearance 기준으로 그려져서, 시스템 다크 + 앱 라이트 테마처럼 어긋나면
//      밝은 배경에 묻힌다(역도 동일).
//   2) 버튼 뒤 불투명 백킹 색(titlebar_backing) — 비활성 위젯의 backdrop 합성은
//      webview 레이어를 샘플링하지 못해 유령이 되므로 테마색 백킹을 깐다.
function syncTitlebarBacking(theme: ThemeSpec, mode: ThemeMode): void {
  try {
    void getCurrentWindow()
      .setTheme(mode)
      .catch(() => {
        // 비지원 플랫폼/권한 부재 — 무시(테마 토큰 렌더에는 영향 없음).
      });
    const { colors } = colorsForMode(theme, mode);
    const hex = theme.chrome.titlebar === "side" ? colors.side : colors.bg;
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return;
    const n = parseInt(m[1], 16);
    void invoke("titlebar_backing", {
      r: ((n >> 16) & 255) / 255,
      g: ((n >> 8) & 255) / 255,
      b: (n & 255) / 255,
    }).catch(() => {
      // 비 macOS/명령 부재 — 무시(백킹은 macOS 전용 보정).
    });
  } catch {
    // 비 Tauri 환경(jsdom 테스트 등) — getCurrentWindow 가 동기 throw 한다.
    // 네이티브 크롬이 없는 환경이므로 동기화 자체가 무의미: 조용히 통과.
  }
}

// 테마 선택(이름/모드) 영속 — app.data 권위 + ls 동기캐시(coreSync). 부트에서 init.
type ThemeSel = { name: string; mode?: ThemeMode };
const themeSync = createCoreSync<ThemeSel>({
  key: "theme",
  lsKey: KEY,
  fallback: { name: DEFAULT_THEME },
  // 권위값 도착(hydrate/다른 창) → 저장 없이 적용.
  apply: (sel) => useTheme.getState().applyPersisted(sel),
});
export const initThemePersistence = (deps: CoreStoreDeps): (() => void) =>
  themeSync.init(deps);

function loadSelection(): ThemeSel {
  return themeSync.loadSync();
}

export const useTheme = create<ThemeState>((set, get) => {
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
  // 선택 적용(DOM + 상태). save=true 면 영속(사용자 동작), false 면 권위 반영(저장 없음).
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

    apply: (name, mode) => applySel(name, mode, true),
    // 권위 반영(저장 없음) — 없는 테마면 무시(폴백 유지).
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
});
