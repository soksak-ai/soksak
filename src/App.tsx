import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { TreeThemeInput } from "@pierre/trees";
import { FileTreeSidebar } from "./components/FileTreeSidebar";
import { FileViewer } from "./components/FileViewer";
import { NewProjectModal } from "./components/NewProjectModal";
import { PaneTree } from "./components/PaneTree";
import { SettingsModal } from "./components/SettingsModal";
import { ViewTabs } from "./components/ViewTabs";
import { useT } from "./i18n";
import {
  collectAllLeafIds,
  collectLeafIds,
  projectOfPane,
  useSessions,
  type ProjectTab,
} from "./state/sessions";
import { terminalSettingsOf, useSettings } from "./state/settings";
import {
  applyTerminalSettingsAll,
  disposeHost,
  pasteToHost,
  setSpawnOptionsProvider,
  setTerminalSettingsProvider,
  setThemeAll,
  setThemeProvider,
} from "./terminal/paneHosts";
import { backgrounds, luminance, themeForBg } from "./terminal/theme";
import "./App.css";

// 파일 경로를 셸·Claude Code 양쪽에서 안전하게: 영숫자와 안전문자 외에는 백슬래시
// 이스케이프(공백 포함). 결과가 ...img.png 처럼 따옴표 없이 확장자로 끝나 Claude Code
// 의 이미지 확장자 정규식과 셸 둘 다에 맞는다.
const shellEscape = (p: string) => p.replace(/[^A-Za-z0-9_./@%+:,=-]/g, "\\$&");

// 좌측 사이드바(파일 트리) 폭 범위(CSS px). 실제 폭은 드래그로 조절(전역, localStorage 영속).
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 640;
const SIDEBAR_DEFAULT = 320;
// 좌측 프로젝트 레일 폭.
const RAIL_MIN = 90;
const RAIL_MAX = 360;
const RAIL_DEFAULT = 150;
// 좌측 콘텐츠(뷰) 탭 스트립 폭.
const VTAB_MIN = 90;
const VTAB_MAX = 360;
const VTAB_DEFAULT = 160;

// 드래그로 폭을 조절하는 패널 공용 훅(localStorage 영속). 모두 좌측 패널이라 우측
// 핸들을 오른쪽으로 끌면 폭이 는다(delta = clientX - 시작X).
function useResizableWidth(key: string, def: number, min: number, max: number) {
  const [w, setW] = useState<number>(() => {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : def;
  });
  const begin = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = w;
    const onMove = (ev: MouseEvent) =>
      setW(Math.min(max, Math.max(min, startW + (ev.clientX - startX))));
    const onUp = () => {
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
  };
  return [w, begin] as const;
}

// 프로젝트의 사이드바가 따라갈 터미널 pane(= 현재 작업 디렉토리 출처).
// 활성 뷰가 터미널이면 그 포커스 pane, 파일이면 첫 터미널 뷰의 포커스 pane.
function cwdPaneOf(project: ProjectTab): string | undefined {
  const active = project.views.find((v) => v.id === project.activeViewId);
  if (active && active.kind === "terminal") return active.focusedPaneId;
  const term = project.views.find((v) => v.kind === "terminal");
  return term && term.kind === "terminal" ? term.focusedPaneId : undefined;
}

function App() {
  const t = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const projectTabPosition = useSettings((s) => s.projectTabPosition);
  const viewTabPosition = useSettings((s) => s.viewTabPosition);

  // 터미널 외형 설정(폰트/커서/스크롤백). 개별 필드 구독 → 객체는 memo 로 안정화.
  const fontFamily = useSettings((s) => s.fontFamily);
  const fontSize = useSettings((s) => s.fontSize);
  const cursorBlink = useSettings((s) => s.cursorBlink);
  const cursorStyle = useSettings((s) => s.cursorStyle);
  const scrollback = useSettings((s) => s.scrollback);
  const termSettings = useMemo(
    () =>
      terminalSettingsOf({
        fontFamily,
        fontSize,
        cursorBlink,
        cursorStyle,
        scrollback,
      }),
    [fontFamily, fontSize, cursorBlink, cursorStyle, scrollback],
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

  // 배경색이 단일 소스. 토글은 프리셋, 색상 피커는 임의 색. 글자색은 밝기로 자동 선택.
  const [bg, setBg] = useState<string>(backgrounds.dark);
  const isDark = luminance(bg) <= 0.5;
  const fg = isDark ? "#e6e6e6" : "#1a1a1a";
  const theme = useMemo(() => themeForBg(bg), [bg]);

  // 파일트리(@pierre/trees) 테마: 앱 배경/글자색을 따라가도록.
  const treeTheme = useMemo<TreeThemeInput>(
    () => ({ type: isDark ? "dark" : "light", bg, fg }),
    [isDark, bg, fg],
  );

  // CSS --bg(그리드 잔여)·xterm theme.background(그리드)·OSC 11 응답이 모두 이 색을 따른다.
  // --fg 는 타이틀바/탭 chrome 텍스트용(배경 밝기에 따라 대비색).
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--bg", bg);
    root.setProperty("--fg", fg);
    // 앱 UI(body) 폰트도 설정의 글꼴을 따른다(터미널 xterm 은 옵션으로 별도 적용).
    root.setProperty("--app-font", fontFamily);
  }, [bg, fg, fontFamily]);

  const {
    tabs,
    activeId,
    closeTab,
    setActive,
    renameTab,
    toggleSidebar,
    addTerminalView,
    openFileView,
    closeView,
    setFileMode,
    splitPane,
    closePane,
  } = useSessions();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const activeProject = tabs.find((t) => t.id === activeId);

  // pane 별 spawn 옵션(프로젝트 root → cwd, 첫 pane → 프로그램 자동 실행) 등록.
  useEffect(() => {
    setSpawnOptionsProvider((paneId) => {
      const proj = projectOfPane(useSessions.getState().tabs, paneId);
      if (!proj) return {};
      const initialCommand =
        paneId === proj.initialPaneId && proj.program !== "terminal"
          ? proj.program
          : undefined;
      return { cwd: proj.root, initialCommand };
    });
  }, []);

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
  const [viewTabW, startViewTabResize] = useResizableWidth(
    "viewTabW",
    VTAB_DEFAULT,
    VTAB_MIN,
    VTAB_MAX,
  );

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
      const s = useSessions.getState();
      const project = s.tabs.find((t) => t.id === s.activeId);
      if (!project) return;
      const view = project.views.find((v) => v.id === project.activeViewId);
      if (key === "d") {
        if (view && view.kind === "terminal") {
          e.preventDefault();
          splitPane(project.id, view.id, view.focusedPaneId, e.shiftKey ? "col" : "row");
        }
      } else if (key === "w" && !e.shiftKey) {
        e.preventDefault();
        if (view && view.kind === "terminal" && collectLeafIds(view.layout).length > 1) {
          closePane(project.id, view.id, view.focusedPaneId);
        } else {
          closeView(project.id, project.activeViewId);
        }
      } else if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        addTerminalView(project.id);
      } else if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar(project.id);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [splitPane, closePane, closeView, addTerminalView, toggleSidebar]);

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

  const commitRename = (id: string, raw: string, fallback: string) => {
    renameTab(id, raw.trim() || fallback);
    setEditingId(null);
  };

  // 프로젝트 탭 목록(상단 가로 / 좌측 세로 양쪽에서 같은 마크업 재사용).
  const projectTabsList = (
    <>
      {tabs.map((proj) => (
        <div
          key={proj.id}
          className={`tab${proj.id === activeId ? " active" : ""}`}
          onClick={() => setActive(proj.id)}
          onDoubleClick={() => setEditingId(proj.id)}
        >
          {editingId === proj.id ? (
            <input
              className="tab-rename"
              defaultValue={proj.title}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commitRename(proj.id, e.target.value, proj.title)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  commitRename(proj.id, e.currentTarget.value, proj.title);
                } else if (e.key === "Escape") {
                  setEditingId(null);
                }
              }}
            />
          ) : (
            <span className="tab-title">{proj.title}</span>
          )}
          {tabs.length > 1 && (
            <button
              type="button"
              className="tab-close"
              title={t("project.close")}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(proj.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="tab-add"
        title={t("project.new")}
        onClick={() => setNewProjectOpen(true)}
      >
        +
      </button>
    </>
  );

  return (
    <div className="app-root">
      {/* 오버레이 타이틀바: 프로젝트 탭. 빈 영역 드래그로 창 이동. */}
      <div className="titlebar" data-tauri-drag-region>
        {projectTabPosition === "top" ? (
          <div className="tabs" data-tauri-drag-region>
            {projectTabsList}
          </div>
        ) : (
          /* 좌측 모드: 타이틀바엔 탭 없이 드래그 영역만(탭은 좌측 레일로). */
          <div className="tabs" data-tauri-drag-region />
        )}
        <div className="titlebar-right">
          {/* HMR 개발 빌드에서만 표시(릴리스 빌드는 import.meta.env.DEV=false). dev↔릴리스 구분. */}
          {import.meta.env.DEV && <span className="dev-badge">DEV</span>}
          <button
            type="button"
            className={`sidebar-toggle${activeProject?.sidebarOpen ? " active" : ""}`}
            title={t("sidebar.toggle")}
            aria-label={t("sidebar.toggle")}
            onClick={() => activeProject && toggleSidebar(activeProject.id)}
          >
            ◧
          </button>
          <input
            type="color"
            className="bg-picker"
            value={bg}
            title={t("bg.title")}
            aria-label={t("bg.aria")}
            onInput={(e) => setBg((e.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            className="theme-toggle"
            title={isDark ? t("theme.lightPreset") : t("theme.darkPreset")}
            aria-label={t("theme.toggle")}
            onClick={() => setBg(isDark ? backgrounds.light : backgrounds.dark)}
          >
            {isDark ? "☀" : "☾"}
          </button>
          <button
            type="button"
            className="settings-toggle"
            title={t("settings.open")}
            aria-label={t("settings.open")}
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
        </div>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {newProjectOpen && (
        <NewProjectModal onClose={() => setNewProjectOpen(false)} />
      )}

      {/* 본문: 좌측 모드면 세로 프로젝트 레일 + 콘텐츠 행. */}
      <div className={`app-body${projectTabPosition === "left" ? " with-rail" : ""}`}>
        {projectTabPosition === "left" && (
          <>
            <div className="project-rail" style={{ width: railW }}>
              {projectTabsList}
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
        {tabs.map((project) => {
          const isActiveProject = project.id === activeId;
          return (
            <div
              key={project.id}
              className="terminal-pane"
              style={{
                visibility: isActiveProject ? "visible" : "hidden",
                zIndex: isActiveProject ? 1 : 0,
              }}
            >
              {/* 좌측 파일 트리 사이드바. 닫히면 width 0(언마운트 X → 상태 유지). */}
              <div
                className="sidebar"
                style={{ width: project.sidebarOpen ? sidebarW : 0 }}
              >
                <FileTreeSidebar
                  paneId={cwdPaneOf(project) ?? ""}
                  onOpenFile={(p) => openFileView(project.id, p)}
                  theme={treeTheme}
                />
              </div>
              {project.sidebarOpen && (
                <div
                  className="sidebar-resizer"
                  onMouseDown={startResize}
                  title="사이드바 폭 조절"
                />
              )}

              {/* 콘텐츠 영역: 뷰 탭(상단 가로 / 좌측 세로) + 뷰 본문(터미널/파일). */}
              <div
                className={`content${viewTabPosition === "left" ? " vtab-left" : ""}`}
              >
                {viewTabPosition === "left" ? (
                  <>
                    <div className="vtab-strip" style={{ width: viewTabW }}>
                      <ViewTabs project={project} vertical />
                    </div>
                    <div
                      className="vtab-resizer"
                      onMouseDown={startViewTabResize}
                      title={t("sidebar.resize")}
                    />
                  </>
                ) : (
                  <ViewTabs project={project} />
                )}

                <div className="view-body">
                  {project.views.map((v) => {
                    const isActiveView = v.id === project.activeViewId;
                    return (
                      <div
                        key={v.id}
                        className="view-pane"
                        style={{
                          visibility: isActiveView ? "visible" : "hidden",
                          zIndex: isActiveView ? 1 : 0,
                        }}
                      >
                        {v.kind === "terminal" ? (
                          <PaneTree
                            node={v.layout}
                            projectId={project.id}
                            viewId={v.id}
                            active={isActiveProject && isActiveView}
                            focusedPaneId={v.focusedPaneId}
                          />
                        ) : (
                          <FileViewer
                            path={v.path}
                            mode={v.mode}
                            isDark={isDark}
                            onMode={(m) => setFileMode(project.id, v.id, m)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}

export default App;
