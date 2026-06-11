import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { TreeThemeInput } from "@pierre/trees";
import { FileTreeSidebar } from "./components/FileTreeSidebar";
import { ContentTabs } from "./components/ContentTabs";
import { GroupArea } from "./components/GroupArea";
import { NewProjectModal } from "./components/NewProjectModal";
import { SettingsModal } from "./components/SettingsModal";
import { useT } from "./i18n";
import {
  allGroups,
  collectAllLeafIds,
  collectLeafIds,
  paneSpawnInfo,
  useSessions,
  type ProjectTab,
} from "./state/sessions";
import { terminalSettingsOf, useSettings } from "./state/settings";
import { useTheme } from "./state/theme";
import {
  applyTerminalSettingsAll,
  disposeHost,
  pasteToHost,
  setSpawnOptionsProvider,
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
// 좌측 프로젝트 레일 폭.
// 레퍼런스(soksak_final): 프로젝트 레일 기본 54px, 드래그 44–110px.
const RAIL_MIN = 44;
const RAIL_MAX = 110;
const RAIL_DEFAULT = 54;

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

function App() {
  const t = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const projectTabPosition = useSettings((s) => s.projectTabPosition);
  const contentTabPosition = useSettings((s) => s.contentTabPosition);

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

  // 테마 시스템(토큰 슬롯)이 단일 소스 — CSS 변수/구조 속성은 테마 엔진이 적용한다.
  // 여기서는 파생값(xterm 팔레트, 파일트리 테마)만 토큰에서 유도한다.
  const themeColors = useTheme((s) => s.colors);
  const effectiveMode = useTheme((s) => s.effectiveMode);
  const toggleMode = useTheme((s) => s.toggleMode);
  const reloadThemes = useTheme((s) => s.reload);
  const bg = themeColors.bg;
  const fg = themeColors.fg;
  const isDark = effectiveMode === "dark";
  const theme = useMemo(() => themeForBg(bg), [bg]);

  // 시작 시 외부 테마(~/.soksak/themes) 1회 스캔.
  useEffect(() => {
    reloadThemes().catch((e) => console.error("테마 스캔 실패:", e));
  }, [reloadThemes]);

  // 파일트리(@pierre/trees) 테마: 앱 배경/글자색을 따라가도록.
  const treeTheme = useMemo<TreeThemeInput>(
    () => ({ type: isDark ? "dark" : "light", bg, fg }),
    [isDark, bg, fg],
  );

  // 앱 UI(body) 폰트는 설정의 글꼴을 따른다(터미널 xterm 은 옵션으로 별도 적용).
  useEffect(() => {
    document.documentElement.style.setProperty("--app-font", fontFamily);
  }, [fontFamily]);

  const {
    tabs,
    activeId,
    closeTab,
    setActive,
    renameTab,
    toggleSidebar,
    addViewToGroup,
    splitWithNewView,
    openFileView,
    closeView,
    splitPane,
    closePane,
  } = useSessions();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const activeProject = tabs.find((t) => t.id === activeId);

  // pane 별 spawn 옵션(프로젝트 root → cwd, 첫 pane → 프로그램 자동 실행) 등록.
  useEffect(() => {
    setSpawnOptionsProvider((paneId) => {
      const info = paneSpawnInfo(useSessions.getState().tabs, paneId);
      return { cwd: info.cwd, shell: info.shell, initialCommand: info.program };
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
      const content =
        project.contents.find((c) => c.id === project.activeContentId) ??
        project.contents[0];
      if (!content) return;
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
        // title 모드: 새 터미널 = 새 패널(분할). tabs 모드: 새 탭.
        if (useSettings.getState().splitHeaderMode === "tabs" || !grp) {
          addViewToGroup(project.id, "terminal");
        } else {
          splitWithNewView(project.id, grp.id, "right");
        }
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
    splitWithNewView,
    toggleSidebar,
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

  // 좌측 레일(54px): 라벨 대신 34px 번호 칩(레퍼런스). 더블클릭=이름변경, 우클릭=닫기.
  const projectRailList = (
    <>
      {tabs.map((proj, i) =>
        editingId === proj.id ? (
          <input
            key={proj.id}
            className="rail-rename"
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
          <div
            key={proj.id}
            className={`rail-chip${proj.id === activeId ? " active" : ""}`}
            title={proj.title}
            onClick={() => setActive(proj.id)}
            onDoubleClick={() => setEditingId(proj.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (tabs.length > 1) closeTab(proj.id);
            }}
          >
            {i + 1}
          </div>
        ),
      )}
      <button
        type="button"
        className="rail-add"
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
          <button
            type="button"
            className="theme-toggle"
            title={isDark ? t("theme.lightPreset") : t("theme.darkPreset")}
            aria-label={t("theme.toggle")}
            onClick={toggleMode}
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
                        style={{
                          visibility: isActiveContent ? "visible" : "hidden",
                          zIndex: isActiveContent ? 1 : 0,
                        }}
                      >
                        <GroupArea
                          content={c}
                          projectId={project.id}
                          isActiveProject={isActiveProject && isActiveContent}
                          isDark={isDark}
                        />
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
