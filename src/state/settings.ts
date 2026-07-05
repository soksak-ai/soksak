import { create } from "zustand";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// 앱 설정: 언어(i18n) + 크롬(탭 위치·아이콘·포커스 등). localStorage 에 영속.
// 터미널 외형(폰트/커서/스크롤백/렌더러/셸)은 코어가 소유하지 않는다 — 터미널 플러그인의
// manifest configuration 이 단일진실(중복 제거). 코어 설정은 터미널을 모른다.

export type Language = "ko" | "en";
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

interface SettingsState {
  language: Language;
  // 프로젝트(최상단) 탭 위치. left 면 사이드바 왼쪽 세로 레일.
  projectTabPosition: TabPosition;
  // 컨텐츠(워크스페이스) 탭 위치. left 면 좌측 세로 스트립(레퍼런스 138px).
  contentTabPosition: TabPosition;
  // 분할 패널 헤더 모드(기본 title).
  splitHeaderMode: SplitHeaderMode;
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
  // 앱 UI 폰트(=앱 크롬 전역). 터미널 폰트와 무관 — 터미널 폰트는 터미널 플러그인이 별도 소유.
  // appFontFamily → --app-font(루트 font-family), appFontSize → --app-font-size(루트 font-size).
  appFontFamily: string;
  appFontSize: number;
  // 오케스트레이터 자연어 콘솔이 스폰하는 에이전트 CLI(로그인셸 PATH 에서 해소). 기본 claude —
  // E2E 는 각본 스텁 경로를 넣어 결정적으로 검증한다(orchestrator/agent.ts).
  orchestratorAgent: string;
  setLanguage: (l: Language) => void;
  setProjectTabPosition: (p: TabPosition) => void;
  setContentTabPosition: (p: TabPosition) => void;
  setSplitHeaderMode: (m: SplitHeaderMode) => void;
  setRemoteDestructive: (p: DangerPolicy) => void;
  setRemoteInject: (p: DangerPolicy) => void;
  setIconSet: (id: string) => void;
  setIconBox: (v: boolean) => void;
  setFocusIndicator: (v: FocusIndicator) => void;
  setDefaultProjectRoot: (root: string) => void;
  setTabCloseConfirm: (v: TabCloseConfirm) => void;
  setRightSidebarMode: (v: RightSidebarMode) => void;
  setAppFontFamily: (v: string) => void;
  setAppFontSize: (v: number) => void;
  setOrchestratorAgent: (v: string) => void;
}

const DEFAULTS = {
  language: "ko" as Language,
  projectTabPosition: "top" as TabPosition,
  contentTabPosition: "top" as TabPosition,
  splitHeaderMode: "title" as SplitHeaderMode,
  remoteDestructive: "allow" as DangerPolicy,
  remoteInject: "allow" as DangerPolicy,
  iconSet: "lucide",
  iconBox: false,
  focusIndicator: "outline" as FocusIndicator,
  defaultProjectRoot: "",
  tabCloseConfirm: "warn" as TabCloseConfirm,
  rightSidebarMode: "overlay" as RightSidebarMode,
  appFontFamily:
    '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, "Courier New", monospace',
  appFontSize: 13,
  orchestratorAgent: "claude",
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
    remoteDestructive: s.remoteDestructive,
    remoteInject: s.remoteInject,
    iconSet: s.iconSet,
    iconBox: s.iconBox,
    focusIndicator: s.focusIndicator,
    defaultProjectRoot: s.defaultProjectRoot,
    tabCloseConfirm: s.tabCloseConfirm,
    rightSidebarMode: s.rightSidebarMode,
    appFontFamily: s.appFontFamily,
    appFontSize: s.appFontSize,
    orchestratorAgent: s.orchestratorAgent,
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
    setAppFontFamily: (appFontFamily) => {
      set({ appFontFamily });
      save();
    },
    setAppFontSize: (appFontSize) => {
      // 앱 UI 폰트 크기 클램프(터미널 폰트와 동일 안전 범위).
      set({ appFontSize: Math.max(6, Math.min(40, appFontSize)) });
      save();
    },
    setOrchestratorAgent: (orchestratorAgent) => {
      set({ orchestratorAgent });
      save();
    },
  };
});
