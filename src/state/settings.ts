import { create } from "zustand";

// 앱 설정: 언어(i18n) + 터미널 외형(폰트/커서/스크롤백). localStorage 에 영속.

export type Language = "ko" | "en";
export type CursorStyle = "block" | "bar" | "underline";
export type TabPosition = "top" | "left";
// 분할 패널 헤더: 제목표시줄(단일 뷰) 또는 탭(여러 뷰 + +).
export type SplitHeaderMode = "title" | "tabs";
// 첫 화면 프로그램(새 컨텐츠/프로젝트 기본). sessions 의 Program 과 동일 값 집합 —
// settings → sessions 단방향 import 를 지키기 위해 여기서 독립 정의.
export type DefaultProgram = "terminal" | "claude" | "codex" | "browser";
// 원격(AI/CLI/MCP) 위험 명령 정책. allow=즉시 실행, deny=차단(권한 게이트, M3).
export type DangerPolicy = "allow" | "deny";

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
  scrollback: number;
}

interface SettingsState extends TerminalSettings {
  language: Language;
  // 프로젝트(최상단) 탭 위치. left 면 사이드바 왼쪽 세로 레일.
  projectTabPosition: TabPosition;
  // 컨텐츠(워크스페이스) 탭 위치. left 면 좌측 세로 스트립(레퍼런스 138px).
  contentTabPosition: TabPosition;
  // 분할 패널 헤더 모드(기본 title).
  splitHeaderMode: SplitHeaderMode;
  // 첫 화면(새 컨텐츠 기본 프로그램). 프로젝트 설정이 있으면 그것이 우선.
  defaultProgram: DefaultProgram;
  // 터미널 셸 경로("" = 시스템 기본 $SHELL). 프로젝트 설정이 있으면 그것이 우선.
  shell: string;
  // 브라우저 시작 URL.
  homeUrl: string;
  // 원격 위험 명령 정책: 파괴적(닫기/제거) / 주입(입력·임의 JS).
  remoteDestructive: DangerPolicy;
  remoteInject: DangerPolicy;
  setLanguage: (l: Language) => void;
  setProjectTabPosition: (p: TabPosition) => void;
  setContentTabPosition: (p: TabPosition) => void;
  setSplitHeaderMode: (m: SplitHeaderMode) => void;
  setDefaultProgram: (p: DefaultProgram) => void;
  setShell: (s: string) => void;
  setHomeUrl: (u: string) => void;
  setRemoteDestructive: (p: DangerPolicy) => void;
  setRemoteInject: (p: DangerPolicy) => void;
  setFontFamily: (v: string) => void;
  setFontSize: (v: number) => void;
  setCursorBlink: (v: boolean) => void;
  setCursorStyle: (v: CursorStyle) => void;
  setScrollback: (v: number) => void;
}

const DEFAULTS = {
  language: "ko" as Language,
  projectTabPosition: "top" as TabPosition,
  contentTabPosition: "top" as TabPosition,
  splitHeaderMode: "title" as SplitHeaderMode,
  defaultProgram: "terminal" as DefaultProgram,
  shell: "",
  homeUrl: "https://www.google.com",
  remoteDestructive: "allow" as DangerPolicy,
  remoteInject: "allow" as DangerPolicy,
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
        projectTabPosition: s.projectTabPosition,
        contentTabPosition: s.contentTabPosition,
        splitHeaderMode: s.splitHeaderMode,
        defaultProgram: s.defaultProgram,
        shell: s.shell,
        homeUrl: s.homeUrl,
        remoteDestructive: s.remoteDestructive,
        remoteInject: s.remoteInject,
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
    setProjectTabPosition: (projectTabPosition) => {
      set({ projectTabPosition });
      save();
    },
    setContentTabPosition: (contentTabPosition) => {
      set({ contentTabPosition });
      save();
    },
    setSplitHeaderMode: (splitHeaderMode) => {
      set({ splitHeaderMode });
      save();
    },
    setDefaultProgram: (defaultProgram) => {
      set({ defaultProgram });
      save();
    },
    setShell: (shell) => {
      set({ shell });
      save();
    },
    setHomeUrl: (homeUrl) => {
      set({ homeUrl });
      save();
    },
    setRemoteDestructive: (remoteDestructive) => {
      set({ remoteDestructive });
      save();
    },
    setRemoteInject: (remoteInject) => {
      set({ remoteInject });
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
