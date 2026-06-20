import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { listenThisWindow } from "./lib/windowEvents";
import { rafThrottle } from "./lib/rafThrottle";
import { parkedStyle } from "./lib/layerPark";
import { LeftSidebarHost } from "./components/LeftSidebarHost";
import { PluginSidebar } from "./components/PluginSidebar";
import { ContentTabs } from "./components/ContentTabs";
import { GroupArea } from "./components/GroupArea";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectSettingsModal } from "./components/ProjectSettingsModal";
import { Icon } from "./ui/icons/Icon";
// 워드마크 로고 — fill 이 currentColor 상속이라 테마를 자동 추종(정적 신뢰 에셋).
import logoRaw from "./assets/soksak_logo.svg?raw";
import { SettingsModal } from "./components/SettingsModal";
import { ConsentPreviewHost } from "./components/ConsentPreviewHost";
import { NotifyHost } from "./ui/NotifyHost";
import { PluginHeaderActions } from "./ui/PluginHeaderActions";
import { useUi } from "./state/ui";
import { useT } from "./i18n";
import {
  allGroups,
  collectAllLeafIds,
  collectLeafIds,
  useSessions,
  type ProjectTab,
} from "./state/sessions";
import {
  terminalSettingsOf,
  useSettings,
  type TabPosition,
} from "./state/settings";
import { useTheme } from "./state/theme";
import {
  applyTerminalSettingsAll,
  disposeHost,
  pasteToHost,
  setTerminalSettingsProvider,
  setThemeAll,
  setThemeProvider,
} from "./terminal/paneHosts";
import { themeForBg } from "./terminal/theme";
import "./App.css";

// 파일 경로를 셸·Claude Code 양쪽에서 안전하게: 영숫자와 안전문자 외에는 백슬래시
// 이스케이프(공백 포함). 결과가 ...img.png 처럼 따옴표 없이 확장자로 끝나 Claude Code
// 의 이미지 확장자 정규식과 셸 둘 다에 맞는다.
const shellEscape = (p: string) => p.replace(/[^A-Za-z0-9_./@%+:,=-]/g, "\\$&");

// 좌측 사이드바(파일 트리) 폭 범위(CSS px). 실제 폭은 드래그로 조절(전역, localStorage 영속).
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 640;
const SIDEBAR_DEFAULT = 320;
// 우측 플러그인 사이드바 폭 범위.
const RIGHT_MIN = 200;
const RIGHT_MAX = 640;
const RIGHT_DEFAULT = 300;
// 좌측 프로젝트 레일 폭.
// 레퍼런스(soksak_final): 프로젝트 레일 기본 54px, 드래그 44–110px.
const RAIL_MIN = 44;
const RAIL_MAX = 110;
const RAIL_DEFAULT = 54;

// 드래그로 폭을 조절하는 패널 공용 훅(localStorage 영속). dir = 패널이 붙은 쪽:
// left(기본) 는 우측 핸들을 오른쪽으로 끌면 폭이 늘고, right 는 좌측 핸들이라 부호 반전.
function useResizableWidth(
  key: string,
  def: number,
  min: number,
  max: number,
  dir: "left" | "right" = "left",
) {
  const [w, setW] = useState<number>(() => {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : def;
  });
  // begin 은 참조 안정(useCallback) — memo 된 ProjectPane 에 prop 으로 내려가도
  // 경계를 깨지 않는다(원칙 2). 현재 폭은 ref 로 읽는다.
  const wRef = useRef(w);
  wRef.current = w;
  const begin = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wRef.current;
    const sign = dir === "left" ? 1 : -1;
    // 폭 상태 갱신은 프레임당 1회(원칙 4) — App 수준 상태라 리렌더 비용이 크다.
    const commitW = rafThrottle((next: number) => setW(next));
    const onMove = (ev: MouseEvent) =>
      commitW(
        Math.min(max, Math.max(min, startW + sign * (ev.clientX - startX))),
      );
    const onUp = () => {
      commitW.flush(); // 리스너 제거 전에 — 마지막 프레임 유실 = 스냅백.
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setW((cur) => {
        localStorage.setItem(key, String(cur));
        return cur;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // key/min/max/dir 은 호출 지점마다 상수.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, min, max, dir]);
  return [w, begin] as const;
}

// 프로젝트 1개의 본문(좌측 사이드바 + 컨텐츠 + 우측 플러그인 사이드바).
// memo 경계 = project 데이터 경계(원칙 2, docs/PERFORMANCE.md): 프로젝트 X 의
// store 쓰기는 프로젝트 Y 의 객체 정체성을 보존(mapProject)하므로 Y 서브트리는
// 리렌더되지 않는다. 모든 prop 은 참조/값 안정이어야 한다 — 커스텀 비교자 금지.
const ProjectPane = memo(function ProjectPane({
  project,
  isActiveProject,
  sidebarW,
  rightW,
  contentTabPosition,
  startResize,
  startRightResize,
}: {
  project: ProjectTab;
  isActiveProject: boolean;
  sidebarW: number;
  rightW: number;
  contentTabPosition: TabPosition;
  startResize: (e: React.MouseEvent) => void;
  startRightResize: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  return (
    <div
      className="terminal-pane"
      style={{
        visibility: isActiveProject ? "visible" : "hidden",
        zIndex: isActiveProject ? 1 : 0,
      }}
    >
      {/* 좌측 파일 트리 사이드바. 닫히면 width 0(언마운트 X → 상태 유지).
          닫힐 때 우측 보더도 함께 제거 — 0폭이어도 보더는 1px 선으로 남아
          사이드바 밖에 보더가 걸린 것처럼 보이기 때문. */}
      <div
        className="sidebar"
        style={{
          width: project.sidebarOpen ? sidebarW : 0,
          borderRightWidth: project.sidebarOpen ? 1 : 0,
        }}
      >
        <LeftSidebarHost
          project={project}
          paneId={cwdPaneOf(project) ?? ""}
        />
      </div>
      {project.sidebarOpen && (
        <div
          className="sidebar-resizer"
          onMouseDown={startResize}
          title="사이드바 폭 조절"
        />
      )}

      {/* 콘텐츠 영역: 컨텐츠 탭 바 + 각 컨텐츠의 에디터 그룹 그리드.
          탭 위치 left 면 가로(행)로 배치해 좌측 세로 스트립 + 본문. */}
      <div
        className={`content${contentTabPosition === "left" ? " ctabs-left" : ""}`}
      >
        <ContentTabs
          project={project}
          vertical={contentTabPosition === "left"}
        />
        <div className="content-body">
          {project.contents.map((c) => {
            const isActiveContent = c.id === project.activeContentId;
            return (
              <div
                key={c.id}
                className="content-pane"
                // 비활성 콘텐츠는 화면 밖으로 파킹(R12 단일 진실) — visibility:hidden 만으로는 그 안의
                // 터미널 WebGL 캔버스가 GPU 레이어로 합성돼 활성 콘텐츠의 브라우저 홀로 비친다. 뷰 슬롯
                // (GroupArea)과 동일 규칙을 같은 헬퍼로 적용(층 간 일치).
                style={parkedStyle(isActiveContent)}
              >
                <GroupArea
                  content={c}
                  projectId={project.id}
                  isActiveProject={isActiveProject && isActiveContent}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* 우측 플러그인 사이드바(⌥⌘B). 닫히면 width 0(언마운트 X — keep-alive). */}
      {project.rightOpen && (
        <div
          className="sidebar-right-resizer"
          style={{ right: rightW - 2 }}
          onMouseDown={startRightResize}
          title={t("plugin.sidebar.resize")}
        />
      )}
      <div
        className={`sidebar-right${project.rightOpen ? " open" : ""}`}
        style={{
          width: project.rightOpen ? rightW : 0,
          borderLeftWidth: project.rightOpen ? 1 : 0,
        }}
      >
        <PluginSidebar project={project} />
      </div>
    </div>
  );
});

// 프로젝트의 사이드바가 따라갈 터미널 pane(= 현재 작업 디렉토리 출처).
// 활성 그룹의 활성 뷰가 터미널이면 그 포커스 pane, 아니면 아무 터미널 뷰의 포커스 pane.
function cwdPaneOf(project: ProjectTab): string | undefined {
  const content =
    project.contents.find((c) => c.id === project.activeContentId) ??
    project.contents[0];
  if (!content) return undefined;
  const groups = allGroups(content.layout);
  const activeGroup =
    groups.find((g) => g.id === content.activeGroupId) ?? groups[0];
  const active = activeGroup?.views.find(
    (v) => v.id === activeGroup.activeViewId,
  );
  if (active && active.kind === "terminal") return active.focusedPaneId;
  for (const g of groups) {
    for (const v of g.views) {
      if (v.kind === "terminal") return v.focusedPaneId;
    }
  }
  return undefined;
}

// 빌드 정체성 배지: DEV(HMR 개발 서버) / DEBUG(디버그 번들 soksak-debug) / 없음(릴리스).
// HMR 은 import.meta.env.DEV 로 즉시 알고, 빌드 번들(DEV=false)은 둘을 앱 이름(getName)
// 으로 가른다 — productName 이 soksak-dev / soksak-debug / soksak 로 정체성을 인코딩한다.
function BuildBadge() {
  const [label, setLabel] = useState<string | null>(
    import.meta.env.DEV ? "DEV" : null,
  );
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let alive = true;
    import("@tauri-apps/api/app")
      .then((m) => m.getName())
      .then((name) => {
        if (alive && name.includes("debug")) setLabel("DEBUG");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!label) return null;
  return (
    <span className={`dev-badge${label === "DEBUG" ? " debug" : ""}`}>
      {label}
    </span>
  );
}

function App() {
  const t = useT();
  const settingsSection = useUi((s) => s.settingsSection);
  const setSettingsSection = useUi((s) => s.setSettingsSection);
  const projectTabPosition = useSettings((s) => s.projectTabPosition);
  const contentTabPosition = useSettings((s) => s.contentTabPosition);

  // 터미널 외형 설정(폰트/커서/스크롤백). 개별 필드 구독 → 객체는 memo 로 안정화.
  const fontFamily = useSettings((s) => s.fontFamily);
  const fontSize = useSettings((s) => s.fontSize);
  const cursorBlink = useSettings((s) => s.cursorBlink);
  const cursorStyle = useSettings((s) => s.cursorStyle);
  const scrollback = useSettings((s) => s.scrollback);
  const resizeReflow = useSettings((s) => s.resizeReflow);
  const xtermRenderer = useSettings((s) => s.xtermRenderer);
  const termSettings = useMemo(
    () =>
      terminalSettingsOf({
        fontFamily,
        fontSize,
        cursorBlink,
        cursorStyle,
        scrollback,
        resizeReflow,
        xtermRenderer,
      }),
    [
      fontFamily,
      fontSize,
      cursorBlink,
      cursorStyle,
      scrollback,
      resizeReflow,
      xtermRenderer,
    ],
  );
  // 새 터미널이 현재 설정으로 생성되도록 provider 등록(ref 로 최신값 제공).
  const termSettingsRef = useRef(termSettings);
  termSettingsRef.current = termSettings;
  useEffect(() => {
    setTerminalSettingsProvider(() => termSettingsRef.current);
  }, []);
  // 설정 변경 시 살아있는 모든 터미널에 라이브 적용.
  useEffect(() => {
    applyTerminalSettingsAll(termSettings);
  }, [termSettings]);

  // 테마 시스템(토큰 슬롯)이 단일 소스 — CSS 변수/구조 속성은 테마 엔진이 적용한다.
  // 여기서는 파생값(xterm 팔레트, 파일트리 테마)만 토큰에서 유도한다.
  const themeColors = useTheme((s) => s.colors);
  const effectiveMode = useTheme((s) => s.effectiveMode);
  const toggleMode = useTheme((s) => s.toggleMode);
  const reloadThemes = useTheme((s) => s.reload);
  const bg = themeColors.bg;
  const isDark = effectiveMode === "dark";
  const theme = useMemo(() => themeForBg(bg), [bg]);

  // 시작 시 외부 테마(~/.soksak/themes) 1회 스캔.
  useEffect(() => {
    reloadThemes().catch((e) => console.error("테마 스캔 실패:", e));
  }, [reloadThemes]);


  // 앱 UI(body) 폰트는 설정의 글꼴을 따른다(터미널 xterm 은 옵션으로 별도 적용).
  useEffect(() => {
    document.documentElement.style.setProperty("--app-font", fontFamily);
  }, [fontFamily]);

  // 아이콘 버튼 라운드박스 — 루트 어트리뷰트로 CSS 분기(data-pane-style 과 동형).
  const iconBox = useSettings((s) => s.iconBox);
  useEffect(() => {
    document.documentElement.dataset.iconBox = iconBox ? "on" : "off";
  }, [iconBox]);

  // 포커스 그룹 표시 스타일(outline|corners) — 루트 어트리뷰트로 CSS 분기.
  const focusIndicator = useSettings((s) => s.focusIndicator);
  useEffect(() => {
    document.documentElement.dataset.focusInd = focusIndicator;
  }, [focusIndicator]);

  // 네이티브 child webview(브라우저) 위 클릭은 메인 DOM 에 이벤트가 오지 않아
  // 포커스 추적이 끊긴다 — 네이티브 모니터(browser.rs)가 emit 한 좌표를
  // elementFromPoint 로 판정해 그룹을 활성화한다. 모달 등이 위에 떠 있으면
  // 그 요소가 잡혀 자연 차단되고, DOM 클릭과 중복돼도 같은 결과라 무해.
  useEffect(() => {
    // 이 창에 emit_to 된 native-mousedown 만 받는다(전역 listen 이면 다른 창 클릭도 받아
    // 엉뚱한 창의 그룹을 활성화). lib/windowEvents 머리말 참조.
    return listenThisWindow<{ x: number; y: number }>("native-mousedown", (e) => {
      const el = document.elementFromPoint(e.payload.x, e.payload.y);
      const slot = el?.closest<HTMLElement>("[data-group-id]");
      const { groupId, projectId } = slot?.dataset ?? {};
      if (groupId && projectId) {
        useSessions.getState().setActiveGroup(projectId, groupId);
      }
    });
  }, []);

  // 내장 브라우저의 새 링크(target=_blank / window.open) — browser.rs 가 마커
  // 네비게이션을 가로채 emit 한다. 새 창/새 탭 분기는 프론트 설정이 소유:
  //   window(기본·무회귀) → 독립 OS 창(browser_open_window invoke)
  //   tab → 활성 프로젝트의 활성 컨텐츠의 활성 그룹에 브라우저 뷰 추가(addViewToGroup).
  // 전역 listen(이 이벤트는 emit_to 가 아닌 app.emit — 어느 창이 처리해도 무방하나
  // 활성 프로젝트 기준이라 사용자가 보는 창에서 자연히 열린다).
  useEffect(() => {
    const unlisten = listen<{ url: string }>("browser-open-external", (e) => {
      const url = e.payload.url;
      const mode = useSettings.getState().browserNewWindow;
      if (mode === "window") {
        invoke("browser_open_window", { url }).catch((err) =>
          console.error("브라우저 새 창 실패:", err),
        );
        return;
      }
      // 앱 내 새 탭: 활성 프로젝트 → 활성 컨텐츠 → 활성 그룹에 브라우저 뷰 추가.
      const s = useSessions.getState();
      const project = s.tabs.find((t) => t.id === s.activeId);
      if (!project) return;
      const content =
        project.contents.find((c) => c.id === project.activeContentId) ??
        project.contents[0];
      if (!content) return;
      const groups = allGroups(content.layout);
      const group =
        groups.find((g) => g.id === content.activeGroupId) ?? groups[0];
      if (!group) return;
      s.addViewToGroup(project.id, "browser", group.id, { url });
    });
    return () => {
      unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  // 구독 최소 원칙(docs/PERFORMANCE.md 1): 필드/액션별 셀렉터만 — bare 훅 금지.
  // zustand 액션은 create() 시점에 고정되는 안정 참조라 액션 셀렉터는 리렌더 없음.
  const tabs = useSessions((s) => s.tabs);
  const activeId = useSessions((s) => s.activeId);
  const closeTab = useSessions((s) => s.closeTab);
  const setActive = useSessions((s) => s.setActive);
  const toggleSidebar = useSessions((s) => s.toggleSidebar);
  const toggleRightSidebar = useSessions((s) => s.toggleRightSidebar);
  const addViewToGroup = useSessions((s) => s.addViewToGroup);
  const closeView = useSessions((s) => s.closeView);
  const splitPane = useSessions((s) => s.splitPane);
  const closePane = useSessions((s) => s.closePane);
  // 프로젝트 설정 모달(이름/색) 대상 프로젝트 id.
  const [projectSettingsFor, setProjectSettingsFor] = useState<string | null>(
    null,
  );
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const activeProject = tabs.find((t) => t.id === activeId);

  // spawn 옵션 provider 는 main.tsx 부트(렌더 전)가 등록한다 — effect(마운트
  // 후)는 자식 PaneLeaf ref 의 첫 spawn 보다 늦어 첫 터미널이 cwd 없이(홈)
  // 시작하던 잠복 버그의 원인이었다.

  // 드래그로 조절되는 패널 폭들(전역, localStorage 영속).
  const [sidebarW, startResize] = useResizableWidth(
    "sidebarW",
    SIDEBAR_DEFAULT,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
  );
  const [railW, startRailResize] = useResizableWidth(
    "railW",
    RAIL_DEFAULT,
    RAIL_MIN,
    RAIL_MAX,
  );
  const [rightW, startRightResize] = useResizableWidth(
    "rightSidebarW",
    RIGHT_DEFAULT,
    RIGHT_MIN,
    RIGHT_MAX,
    "right",
  );

  // 우측 사이드바(.sidebar-right)는 풀사이즈 브라우저 webview 위에 뜬 DOM 오버레이다
  // (position:absolute, z-index 20). 그 사각형을 네이티브 hit_test 의 "홀"로 보고하면
  // 그 영역의 스크롤/클릭이 아래 브라우저로 새지 않고 DOM(사이드바)이 받는다. webview 는
  // 풀사이즈 그대로 유지된다(과거의 webview 폭 클램프 우회는 폐지 — browser.rs 참조).
  const rightRect = activeProject?.rightOpen ? rightW : 0;
  useLayoutEffect(() => {
    // 닫힘(rightOpen false 또는 폭 0)이면 홀 비움.
    if (!activeProject?.rightOpen || rightW <= 0) {
      invoke("browser_dom_holes", { holes: [] }).catch(() => {});
      return;
    }
    // 폭 변경 등 레이아웃이 커밋된 *다음* 프레임에 측정한다 — rAF 전엔 사이드바 폭이
    // 아직 반영 전이라 rect 가 어긋난다.
    const report = () => {
      const sb = document.querySelector(".sidebar-right.open");
      if (!sb) {
        invoke("browser_dom_holes", { holes: [] }).catch(() => {});
        return;
      }
      const r = sb.getBoundingClientRect();
      invoke("browser_dom_holes", {
        holes: [{ x: r.left, y: r.top, w: r.width, h: r.height }],
      }).catch(() => {});
    };
    const raf = requestAnimationFrame(report);
    // 창 리사이즈도 사이드바 rect(우변 고정·높이)를 옮긴다 — 다시 측정.
    const onWinResize = () => requestAnimationFrame(report);
    window.addEventListener("resize", onWinResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onWinResize);
    };
    // rightRect = rightOpen·rightW 의 단일 파생 — 둘 중 무엇이 바뀌어도 재측정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightRect]);

  // 새 호스트의 최초 createTerminal 이 현재 테마로 생성되도록 provider 등록.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  useEffect(() => {
    setThemeProvider(() => themeRef.current);
  }, []);

  // 테마 변경 시 살아있는 모든 터미널에 라이브 적용.
  useEffect(() => {
    setThemeAll(theme);
  }, [theme]);

  // 호스트 폐기 diff: 모든 프로젝트·터미널 뷰의 leaf id 집합을 추적해, 사라진 paneId 만
  // disposeHost(뷰/탭 닫기·pane 닫기 모두 여기서). 재렌더로는 폐기되지 않음.
  const liveLeavesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(collectAllLeafIds(tabs));
    for (const id of liveLeavesRef.current) {
      if (!current.has(id)) disposeHost(id);
    }
    liveLeavesRef.current = current;
  }, [tabs]);

  // 키보드 단축키(캡처 단계 → xterm 보다 먼저). 활성 프로젝트의 활성 뷰 기준.
  // ⌘D 좌우분할 / ⌘⇧D 상하분할 / ⌘W pane→뷰 닫기 / ⌘T 새 터미널 / ⌘B 사이드바.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();
      // ⌘N 새 창(독립 작업공간) — 프로젝트 무관이라 가장 먼저 처리.
      if (key === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        invoke("window_create").catch((err) => console.error("새 창 실패:", err));
        return;
      }
      const s = useSessions.getState();
      const project = s.tabs.find((t) => t.id === s.activeId);
      if (!project) return;
      const content =
        project.contents.find((c) => c.id === project.activeContentId) ??
        project.contents[0];
      if (!content) return;
      // ⌥⌘B 우측 플러그인 사이드바. ⌥ 조합은 e.key 가 합성문자("∫")라 e.code 로 판정.
      if (e.altKey && !e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        toggleRightSidebar(project.id);
        return;
      }
      const groups = allGroups(content.layout);
      const grp =
        groups.find((g) => g.id === content.activeGroupId) ?? groups[0];
      const view = grp?.views.find((v) => v.id === grp.activeViewId);
      if (key === "d") {
        if (view && view.kind === "terminal") {
          e.preventDefault();
          splitPane(project.id, view.id, view.focusedPaneId, e.shiftKey ? "col" : "row");
        }
      } else if (key === "w" && !e.shiftKey) {
        e.preventDefault();
        if (view && view.kind === "terminal" && collectLeafIds(view.layout).length > 1) {
          closePane(project.id, view.id, view.focusedPaneId);
        } else if (view) {
          closeView(project.id, view.id);
        }
      } else if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        // 분할 패널 헤더 = 탭 모드 고정: ⌘T 는 항상 새 탭.
        addViewToGroup(project.id, "terminal");
      } else if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar(project.id);
      } else if (key === "=" || key === "+") {
        // ⌘+ 글자 크게 / ⌘- 작게 / ⌘0 기본(13). 터미널·UI 폰트 모두 설정을 따른다.
        e.preventDefault();
        const st = useSettings.getState();
        st.setFontSize(st.fontSize + 1);
      } else if (key === "-") {
        e.preventDefault();
        const st = useSettings.getState();
        st.setFontSize(st.fontSize - 1);
      } else if (key === "0") {
        e.preventDefault();
        useSettings.getState().setFontSize(13);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    splitPane,
    closePane,
    closeView,
    addViewToGroup,
    toggleSidebar,
    toggleRightSidebar,
  ]);

  // 파일 드래그&드롭: 드롭 위치 아래의 pane-host(터미널)에 이스케이프 경로를 붙여넣는다.
  // pane 이 아니면 활성 프로젝트의 터미널 pane 으로 폴백.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const { paths, position } = event.payload;
      if (!paths || paths.length === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(position.x / dpr, position.y / dpr);
      let paneId = el?.closest<HTMLElement>(".pane-host")?.dataset.paneId;
      if (!paneId) {
        const s = useSessions.getState();
        const proj = s.tabs.find((t) => t.id === s.activeId);
        paneId = proj ? cwdPaneOf(proj) : undefined;
      }
      if (!paneId) return;
      pasteToHost(paneId, paths.map(shellEscape).join(" "));
    });
    return () => {
      unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  // 프로젝트 탭 목록(상단 가로 / 좌측 세로 양쪽에서 같은 마크업 재사용).
  // 더블클릭 = 프로젝트 설정 모달(이름 + 식별 색 — 인라인 rename 대체).
  const projectTabsList = (
    <>
      {tabs.map((proj) => (
        <div
          key={proj.id}
          className={`tab${proj.id === activeId ? " active" : ""}`}
          onClick={() => setActive(proj.id)}
          onDoubleClick={() => setProjectSettingsFor(proj.id)}
        >
          {proj.color && (
            <span className="tab-dot" style={{ background: proj.color }} />
          )}
          <span className="tab-title">{proj.title}</span>
          {tabs.length > 1 && (
            <button
              type="button"
              className="icon-btn icon-btn--mini tab-close"
              title={t("project.close")}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(proj.id);
              }}
            >
              <Icon name="close" size="sm" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="icon-btn tab-add"
        title={t("project.new")}
        onClick={() => setNewProjectOpen(true)}
      >
        <Icon name="add" />
      </button>
    </>
  );

  // 좌측 레일: 칩 폭 = 레일 폭 추종(적응형). 라벨은 말줄임, 최소폭(RAIL_MIN)까지
  // 줄이면 첫 글자만(말줄임 없음). 더블클릭=프로젝트 설정(이름/색), 우클릭=닫기.
  const railAtMin = railW <= RAIL_MIN;
  const projectRailList = (
    <>
      {tabs.map((proj) => (
        <div
          key={proj.id}
          className={`rail-chip${proj.id === activeId ? " active" : ""}`}
          title={proj.title}
          style={
            proj.color
              ? { borderColor: proj.color, color: proj.color }
              : undefined
          }
          onClick={() => setActive(proj.id)}
          onDoubleClick={() => setProjectSettingsFor(proj.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (tabs.length > 1) closeTab(proj.id);
          }}
        >
          <span className="rail-chip-label">
            {railAtMin ? ([...proj.title][0] ?? "") : proj.title}
          </span>
        </div>
      ))}
      <button
        type="button"
        className="rail-add"
        title={t("project.new")}
        onClick={() => setNewProjectOpen(true)}
      >
        <Icon name="add" size="lg" />
      </button>
    </>
  );

  return (
    <div className="app-root">
      {/* 오버레이 타이틀바: 로고(최앞단 고정) + 프로젝트 탭. 빈 영역 드래그로 창 이동. */}
      <div className="titlebar" data-tauri-drag-region>
        {/* 로고는 신호등(82px) 바로 뒤 고정 — 탭은 항상 로고 뒤부터 쌓인다.
            pointer-events:none 으로 창 드래그를 가로채지 않는다. */}
        <span
          className="titlebar-logo"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: logoRaw }}
        />
        {/* 빌드 정체성 배지(DEV=HMR / DEBUG=디버그 번들) — 로고 바로 뒤 고정. 프로젝트
            탭(상단 모드)은 이 뒤부터 쌓인다. 릴리스(soksak)는 배지 없음. */}
        <BuildBadge />
        {projectTabPosition === "top" ? (
          <div className="tabs" data-tauri-drag-region>
            {projectTabsList}
          </div>
        ) : (
          /* 좌측 모드: 타이틀바엔 탭 없이 드래그 영역만(탭은 좌측 레일로). */
          <div className="tabs" data-tauri-drag-region />
        )}
        <div className="titlebar-right">
          <PluginHeaderActions />
          <button
            type="button"
            className={`icon-btn sidebar-toggle${activeProject?.sidebarOpen ? " active" : ""}`}
            title={t("sidebar.toggle")}
            aria-label={t("sidebar.toggle")}
            onClick={() => activeProject && toggleSidebar(activeProject.id)}
          >
            <Icon name="panel-left" />
          </button>
          <button
            type="button"
            className={`icon-btn sidebar-toggle${activeProject?.rightOpen ? " active" : ""}`}
            title={t("plugin.sidebar.toggle")}
            aria-label={t("plugin.sidebar.toggle")}
            onClick={() =>
              activeProject && toggleRightSidebar(activeProject.id)
            }
          >
            <Icon name="panel-right" />
          </button>
          <button
            type="button"
            className="icon-btn theme-toggle"
            title={isDark ? t("theme.lightPreset") : t("theme.darkPreset")}
            aria-label={t("theme.toggle")}
            onClick={toggleMode}
          >
            <Icon name={isDark ? "sun" : "moon"} />
          </button>
          <button
            type="button"
            className="icon-btn settings-toggle"
            title={t("settings.open")}
            aria-label={t("settings.open")}
            onClick={() => setSettingsSection("general")}
          >
            <Icon name="settings" />
          </button>
        </div>
      </div>

      {settingsSection !== null && (
        <SettingsModal
          initialSection={settingsSection}
          onClose={() => setSettingsSection(null)}
        />
      )}
      <ConsentPreviewHost />
      {newProjectOpen && (
        <NewProjectModal onClose={() => setNewProjectOpen(false)} />
      )}
      {projectSettingsFor && (
        <ProjectSettingsModal
          projectId={projectSettingsFor}
          onClose={() => setProjectSettingsFor(null)}
        />
      )}

      {/* 본문: 좌측 모드면 세로 프로젝트 레일 + 콘텐츠 행. */}
      <div className={`app-body${projectTabPosition === "left" ? " with-rail" : ""}`}>
        {projectTabPosition === "left" && (
          <>
            <div className="project-rail" style={{ width: railW }}>
              {projectRailList}
            </div>
            <div
              className="project-rail-resizer"
              onMouseDown={startRailResize}
              title={t("sidebar.resize")}
            />
          </>
        )}
        {/* 모든 프로젝트를 마운트해 세션 유지(비활성은 visibility 로 숨김). */}
        <div className="terminal-stack">
          {tabs.map((project) => (
            <ProjectPane
              key={project.id}
              project={project}
              isActiveProject={project.id === activeId}
              sidebarW={sidebarW}
              rightW={rightW}
              contentTabPosition={contentTabPosition}
              startResize={startResize}
              startRightResize={startRightResize}
            />
          ))}
        </div>
      </div>
      {/* 인앱 알림 배너(포커스 시) — 앱 루트 최상단 오버레이. */}
      <NotifyHost />
    </div>
  );
}

export default App;
