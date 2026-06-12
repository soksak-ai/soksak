import { create } from "zustand";

// 앱 설정: 언어(i18n) + 터미널 외형(폰트/커서/스크롤백). localStorage 에 영속.

export type Language = "ko" | "en";
export type CursorStyle = "block" | "bar" | "underline";
export type TabPosition = "top" | "left";
// 분할 패널 헤더: 제목표시줄(단일 뷰) 또는 탭(여러 뷰 + +).
export type SplitHeaderMode = "title" | "tabs";
// 첫 화면 프로그램(새 컨텐츠/프로젝트 기본). 내장 "terminal"·"browser" +
// 플러그인 등록 프로그램 id — 미등록 값은 사용 시점에 터미널 폴백.
// settings → sessions 단방향 import 를 지키기 위해 여기서 독립 정의.
export type DefaultProgram = string;
// 원격(AI/CLI/MCP) 위험 명령 정책. allow=즉시 실행, deny=차단(권한 게이트, M3).
export type DangerPolicy = "allow" | "deny";
// 포커스 영역 표시: outline=사각 아웃라인, corners=모서리 꺽쇠 4개.
export type FocusIndicator = "outline" | "corners";

// 리사이즈 중 터미널 리플로우 정책(docs/PERFORMANCE.md 원칙 4·5):
//   live   = 드래그 중에도 프레임당 1회 fit(실시간 리플로우, editor 스타일)
//   settle = 입력 정착(150ms) 후 1회 fit(드래그 중 리플로우 없음, CPU 최소)
// 양쪽 모두 PTY resize(SIGWINCH)는 정착 후 1회만 보낸다.
export type ResizeReflow = "live" | "settle";

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
  scrollback: number;
  resizeReflow: ResizeReflow;
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
  // 아이콘 셋 id(내장 "lucide" + 플러그인 등록 셋). 미등록이면 lucide 폴백.
  iconSet: string;
  // 아이콘 버튼 라운드박스(보더+배경) 상시 표시 여부. off = 베어(hover 만).
  iconBox: boolean;
  // 포커스 그룹 표시 스타일(그룹 2개 이상일 때 활성 그룹에 표시).
  focusIndicator: FocusIndicator;
  setLanguage: (l: Language) => void;
  setProjectTabPosition: (p: TabPosition) => void;
  setContentTabPosition: (p: TabPosition) => void;
  setSplitHeaderMode: (m: SplitHeaderMode) => void;
  setDefaultProgram: (p: DefaultProgram) => void;
  setShell: (s: string) => void;
  setHomeUrl: (u: string) => void;
  setRemoteDestructive: (p: DangerPolicy) => void;
  setRemoteInject: (p: DangerPolicy) => void;
  setIconSet: (id: string) => void;
  setIconBox: (v: boolean) => void;
  setFocusIndicator: (v: FocusIndicator) => void;
  setFontFamily: (v: string) => void;
  setFontSize: (v: number) => void;
  setCursorBlink: (v: boolean) => void;
  setCursorStyle: (v: CursorStyle) => void;
  setScrollback: (v: number) => void;
  setResizeReflow: (v: ResizeReflow) => void;
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
  iconSet: "lucide",
  iconBox: false,
  focusIndicator: "outline" as FocusIndicator,
  fontFamily:
    '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, "Courier New", monospace',
  fontSize: 13,
  cursorBlink: true,
  cursorStyle: "block" as CursorStyle,
  scrollback: 10000,
  resizeReflow: "live" as ResizeReflow,
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
    resizeReflow: s.resizeReflow,
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
        iconSet: s.iconSet,
        iconBox: s.iconBox,
        focusIndicator: s.focusIndicator,
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
    setIconSet: (iconSet) => {
      set({ iconSet });
      save();
    },
    setIconBox: (iconBox) => {
      set({ iconBox });
      save();
    },
    setFocusIndicator: (focusIndicator) => {
      set({ focusIndicator });
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
    setResizeReflow: (resizeReflow) => {
      set({ resizeReflow });
      save();
    },
  };
});
