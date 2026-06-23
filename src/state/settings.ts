import { create } from "zustand";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// 앱 설정: 언어(i18n) + 터미널 외형(폰트/커서/스크롤백). localStorage 에 영속.

export type Language = "ko" | "en";
export type CursorStyle = "block" | "bar" | "underline";
export type TabPosition = "top" | "left";
// 분할 패널 헤더: 제목표시줄(단일 뷰) 또는 탭(여러 뷰 + +).
export type SplitHeaderMode = "title" | "tabs";
// 원격(AI/CLI/MCP) 위험 명령 정책. allow=즉시 실행, deny=차단(권한 게이트, M3).
export type DangerPolicy = "allow" | "deny";
// 포커스 영역 표시: outline=사각 아웃라인, corners=모서리 꺽쇠 4개.
export type FocusIndicator = "outline" | "corners";
// 탭 닫기 확인 정책(R6) — warn=blocking status(미저장·실행 중 등)면 확인창, off=무조건 즉시 닫기.
export type TabCloseConfirm = "warn" | "off";
// 우측 플러그인 사이드바 배치: overlay=콘텐츠 위에 뜸(기존), push=좌측 사이드바처럼 영역 차지(콘텐츠 밀어냄).
export type RightSidebarMode = "overlay" | "push";

// 리사이즈 중 터미널 리플로우 정책(docs/PERFORMANCE.md 원칙 4·5):
//   live   = 드래그 중에도 프레임당 1회 fit(실시간 리플로우, editor 스타일)
//   settle = 입력 정착(150ms) 후 1회 fit(드래그 중 리플로우 없음, CPU 최소)
// 양쪽 모두 PTY resize(SIGWINCH)는 정착 후 1회만 보낸다.
export type ResizeReflow = "live" | "settle";

// xterm.js 전용 렌더러 백엔드(docs/PERFORMANCE.md [렌더러 선택]). dom/webgl 은
// xterm 구현에만 있는 개념이라 xterm 스코프로 명명한다 — 다른 터미널 백엔드가
// 들어오면 자기 스코프 설정을 따로 갖고 일반 term.* 인터페이스는 유지된다.
//   webgl = GPU 렌더러. 처리량 우선 기본값. 단 창 리사이즈 중 합성 레이어(<canvas>)가
//           새 크기로 스케일돼 글자가 늘어난다(WKWebView 구조적 한계).
//   dom   = xterm DOM 렌더러. 리사이즈 정확성이 필요할 때 전환 — macOS WKWebView 라이브
//           리사이즈에서 글자가 안 늘어난다(WebKit 이 DOM 을 매 프레임 타일 재래스터).
export type XtermRenderer = "dom" | "webgl";

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
  scrollback: number;
  resizeReflow: ResizeReflow;
  xtermRenderer: XtermRenderer;
}

interface SettingsState extends TerminalSettings {
  language: Language;
  // 프로젝트(최상단) 탭 위치. left 면 사이드바 왼쪽 세로 레일.
  projectTabPosition: TabPosition;
  // 컨텐츠(워크스페이스) 탭 위치. left 면 좌측 세로 스트립(레퍼런스 138px).
  contentTabPosition: TabPosition;
  // 분할 패널 헤더 모드(기본 title).
  splitHeaderMode: SplitHeaderMode;
  // 터미널 셸 경로("" = 시스템 기본 $SHELL). 프로젝트 설정이 있으면 그것이 우선.
  shell: string;
  // 원격 위험 명령 정책: 파괴적(닫기/제거) / 주입(입력·임의 JS).
  remoteDestructive: DangerPolicy;
  remoteInject: DangerPolicy;
  // 아이콘 셋 id(내장 "lucide" + 플러그인 등록 셋). 미등록이면 lucide 폴백.
  iconSet: string;
  // 아이콘 버튼 라운드박스(보더+배경) 상시 표시 여부. off = 베어(hover 만).
  iconBox: boolean;
  // 포커스 그룹 표시 스타일(그룹 2개 이상일 때 활성 그룹에 표시).
  focusIndicator: FocusIndicator;
  // 앱 첫 오픈 시 가리킬 기본 프로젝트 루트("" = 자동 project1). 프로젝트
  // 설정의 "기본 프로젝트" 체크박스가 저장 — 부트(main.tsx)가 소비.
  defaultProjectRoot: string;
  // 탭 닫기 확인 정책(R6 — warn 기본).
  tabCloseConfirm: TabCloseConfirm;
  rightSidebarMode: RightSidebarMode;
  setLanguage: (l: Language) => void;
  setProjectTabPosition: (p: TabPosition) => void;
  setContentTabPosition: (p: TabPosition) => void;
  setSplitHeaderMode: (m: SplitHeaderMode) => void;
  setShell: (s: string) => void;
  setRemoteDestructive: (p: DangerPolicy) => void;
  setRemoteInject: (p: DangerPolicy) => void;
  setIconSet: (id: string) => void;
  setIconBox: (v: boolean) => void;
  setFocusIndicator: (v: FocusIndicator) => void;
  setDefaultProjectRoot: (root: string) => void;
  setTabCloseConfirm: (v: TabCloseConfirm) => void;
  setRightSidebarMode: (v: RightSidebarMode) => void;
  setFontFamily: (v: string) => void;
  setFontSize: (v: number) => void;
  setCursorBlink: (v: boolean) => void;
  setCursorStyle: (v: CursorStyle) => void;
  setScrollback: (v: number) => void;
  setResizeReflow: (v: ResizeReflow) => void;
  setXtermRenderer: (v: XtermRenderer) => void;
}

const DEFAULTS = {
  language: "ko" as Language,
  projectTabPosition: "top" as TabPosition,
  contentTabPosition: "top" as TabPosition,
  splitHeaderMode: "title" as SplitHeaderMode,
  shell: "",
  remoteDestructive: "allow" as DangerPolicy,
  remoteInject: "allow" as DangerPolicy,
  iconSet: "lucide",
  iconBox: false,
  focusIndicator: "outline" as FocusIndicator,
  defaultProjectRoot: "",
  tabCloseConfirm: "warn" as TabCloseConfirm,
  rightSidebarMode: "overlay" as RightSidebarMode,
  fontFamily:
    '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, "Courier New", monospace',
  fontSize: 13,
  cursorBlink: true,
  cursorStyle: "block" as CursorStyle,
  scrollback: 10000,
  resizeReflow: "live" as ResizeReflow,
  xtermRenderer: "webgl" as XtermRenderer,
};

const KEY = "soksak.settings";

type PersistedSettings = typeof DEFAULTS;

// 영속 대상 필드만 추출(setter·메서드 제외) — load/save/applyPersisted 공유 단일진실.
function serialize(s: SettingsState): PersistedSettings {
  return {
    language: s.language,
    projectTabPosition: s.projectTabPosition,
    contentTabPosition: s.contentTabPosition,
    splitHeaderMode: s.splitHeaderMode,
    shell: s.shell,
    remoteDestructive: s.remoteDestructive,
    remoteInject: s.remoteInject,
    iconSet: s.iconSet,
    iconBox: s.iconBox,
    focusIndicator: s.focusIndicator,
    defaultProjectRoot: s.defaultProjectRoot,
    tabCloseConfirm: s.tabCloseConfirm,
    rightSidebarMode: s.rightSidebarMode,
    ...terminalSettingsOf(s),
  };
}

// app.data 권위 + ls 동기캐시. 부트에서 init. apply=권위 도착 시 스토어 반영(저장 없음).
const settingsSync = createCoreSync<PersistedSettings>({
  key: "settings",
  lsKey: KEY,
  fallback: DEFAULTS,
  apply: (v) => useSettings.setState({ ...DEFAULTS, ...v }),
});
export const initSettingsPersistence = (deps: CoreStoreDeps): (() => void) =>
  settingsSync.init(deps);

function load(): PersistedSettings {
  return { ...DEFAULTS, ...settingsSync.loadSync() };
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
    xtermRenderer: s.xtermRenderer,
  };
}

export const useSettings = create<SettingsState>((set, get) => {
  const save = () => {
    settingsSync.save(serialize(get()));
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
    setShell: (shell) => {
      set({ shell });
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
    setDefaultProjectRoot: (defaultProjectRoot) => {
      set({ defaultProjectRoot });
      save();
    },
    setTabCloseConfirm: (tabCloseConfirm) => {
      set({ tabCloseConfirm });
      save();
    },
    setRightSidebarMode: (rightSidebarMode) => {
      set({ rightSidebarMode });
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
    setXtermRenderer: (xtermRenderer) => {
      set({ xtermRenderer });
      save();
    },
  };
});
