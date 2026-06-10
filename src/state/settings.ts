import { create } from "zustand";

// 앱 설정: 언어(i18n) + 터미널 외형(폰트/커서/스크롤백). localStorage 에 영속.

export type Language = "ko" | "en";
export type CursorStyle = "block" | "bar" | "underline";

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
  scrollback: number;
}

interface SettingsState extends TerminalSettings {
  language: Language;
  setLanguage: (l: Language) => void;
  setFontFamily: (v: string) => void;
  setFontSize: (v: number) => void;
  setCursorBlink: (v: boolean) => void;
  setCursorStyle: (v: CursorStyle) => void;
  setScrollback: (v: number) => void;
}

const DEFAULTS = {
  language: "ko" as Language,
  fontFamily:
    '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, "Courier New", monospace',
  fontSize: 13,
  cursorBlink: true,
  cursorStyle: "block" as CursorStyle,
  scrollback: 10000,
};

const KEY = "soksak.settings";

function load(): typeof DEFAULTS {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

// 터미널 외형만 추출(createTerminal/paneHosts 에 전달).
export function terminalSettingsOf(s: TerminalSettings): TerminalSettings {
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    cursorBlink: s.cursorBlink,
    cursorStyle: s.cursorStyle,
    scrollback: s.scrollback,
  };
}

export const useSettings = create<SettingsState>((set, get) => {
  const save = () => {
    const s = get();
    localStorage.setItem(
      KEY,
      JSON.stringify({
        language: s.language,
        ...terminalSettingsOf(s),
      }),
    );
  };
  return {
    ...load(),
    setLanguage: (language) => {
      set({ language });
      save();
    },
    setFontFamily: (fontFamily) => {
      set({ fontFamily });
      save();
    },
    setFontSize: (fontSize) => {
      set({ fontSize: Math.max(6, Math.min(40, fontSize)) });
      save();
    },
    setCursorBlink: (cursorBlink) => {
      set({ cursorBlink });
      save();
    },
    setCursorStyle: (cursorStyle) => {
      set({ cursorStyle });
      save();
    },
    setScrollback: (scrollback) => {
      set({ scrollback: Math.max(0, Math.min(1_000_000, scrollback)) });
      save();
    },
  };
});
