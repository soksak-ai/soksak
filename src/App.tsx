import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { PaneTree } from "./components/PaneTree";
import { collectLeafIds, useSessions } from "./state/sessions";
import {
  disposeHost,
  pasteToHost,
  setThemeAll,
  setThemeProvider,
} from "./terminal/paneHosts";
import { backgrounds, luminance, themeForBg } from "./terminal/theme";
import "./App.css";

// 파일 경로를 셸·Claude Code 양쪽에서 안전하게: 영숫자와 안전문자 외에는 백슬래시
// 이스케이프(공백 포함). 결과가 ...img.png 처럼 따옴표 없이 확장자로 끝나 Claude Code
// 의 이미지 확장자 정규식과 셸 둘 다에 맞는다.
const shellEscape = (p: string) => p.replace(/[^A-Za-z0-9_./@%+:,=-]/g, "\\$&");

function App() {
  // 배경색이 단일 소스. 토글은 프리셋, 색상 피커는 임의 색. 글자색은 밝기로 자동 선택.
  const [bg, setBg] = useState<string>(backgrounds.dark);
  const isDark = luminance(bg) <= 0.5;
  const theme = useMemo(() => themeForBg(bg), [bg]);

  // CSS --bg(그리드 잔여)·xterm theme.background(그리드)·OSC 11 응답이 모두 이 색을 따른다.
  // --fg 는 타이틀바/탭 chrome 텍스트용(배경 밝기에 따라 대비색).
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--bg", bg);
    root.setProperty("--fg", isDark ? "#e6e6e6" : "#1a1a1a");
  }, [bg, isDark]);

  const {
    tabs,
    activeId,
    addTab,
    closeTab,
    setActive,
    renameTab,
    splitPane,
    closePane,
  } = useSessions();
  const [editingId, setEditingId] = useState<string | null>(null);

  // 새 호스트의 최초 createTerminal 이 현재 테마로 생성되도록 provider 등록.
  // ref 로 최신 theme 을 읽어 재등록 없이 항상 현재값을 제공한다.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  useEffect(() => {
    setThemeProvider(() => themeRef.current);
  }, []);

  // 테마 변경 시 살아있는 모든 터미널에 라이브 적용(호스트가 터미널을 소유).
  useEffect(() => {
    setThemeAll(theme);
  }, [theme]);

  // 호스트 폐기 diff: 모든 탭 레이아웃의 leaf id 집합을 추적해, 사라진 paneId 만
  // disposeHost 한다(pane 닫기·탭 닫기 모두 여기서 처리). 재렌더로는 폐기되지 않음.
  const liveLeavesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set<string>();
    for (const t of tabs) collectLeafIds(t.layout, []).forEach((id) => current.add(id));
    for (const id of liveLeavesRef.current) {
      if (!current.has(id)) disposeHost(id);
    }
    liveLeavesRef.current = current;
  }, [tabs]);

  // 키보드 단축키(캡처 단계 → xterm 보다 먼저 가로챈다).
  // Cmd+D: 좌우 분할(열, dir "row") / Cmd+Shift+D: 상하 분할(행, dir "col")
  // Cmd+W: 활성 탭의 포커스된 pane 닫기(탭 자체는 닫지 않음).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();
      // 최신 store 스냅샷에서 활성 탭/포커스 pane 을 읽는다.
      const s = useSessions.getState();
      const tab = s.tabs.find((t) => t.id === s.activeId);
      if (!tab) return;
      if (key === "d") {
        e.preventDefault();
        splitPane(tab.id, tab.focusedPaneId, e.shiftKey ? "col" : "row");
      } else if (key === "w" && !e.shiftKey) {
        e.preventDefault();
        closePane(tab.id, tab.focusedPaneId);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [splitPane, closePane]);

  // 파일 드래그&드롭: Tauri 가 OS 파일 드롭을 가로채 경로를 준다(웹뷰 HTML drop 은
  // 억제됨). 드롭 위치(물리 px) 아래의 pane-host 를 찾아 그 터미널에 이스케이프 경로를
  // 붙여넣는다. Claude Code 는 .png/.jpg/... 확장자를 감지해 이미지를 읽는다.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const { paths, position } = event.payload;
      if (!paths || paths.length === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(position.x / dpr, position.y / dpr);
      let paneId = el?.closest<HTMLElement>(".pane-host")?.dataset.paneId;
      if (!paneId) {
        // 폴백: 활성 탭의 포커스된 pane.
        const s = useSessions.getState();
        paneId = s.tabs.find((t) => t.id === s.activeId)?.focusedPaneId;
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

  return (
    <div className="app-root">
      {/* 오버레이 타이틀바: macOS 신호등(좌측)과 같은 라인. 빈 영역 드래그로 창 이동. */}
      <div className="titlebar" data-tauri-drag-region>
        <div className="tabs" data-tauri-drag-region>
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab${t.id === activeId ? " active" : ""}`}
              onClick={() => setActive(t.id)}
              onDoubleClick={() => setEditingId(t.id)}
            >
              {editingId === t.id ? (
                <input
                  className="tab-rename"
                  defaultValue={t.title}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => commitRename(t.id, e.target.value, t.title)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      commitRename(t.id, e.currentTarget.value, t.title);
                    } else if (e.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                />
              ) : (
                <span className="tab-title">{t.title}</span>
              )}
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="tab-close"
                  title="탭 닫기"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
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
            title="새 탭"
            onClick={addTab}
          >
            +
          </button>
        </div>
        <div className="titlebar-right">
          <input
            type="color"
            className="bg-picker"
            value={bg}
            title="배경색 지정"
            aria-label="배경색"
            onInput={(e) => setBg((e.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            className="theme-toggle"
            title={isDark ? "라이트 프리셋" : "다크 프리셋"}
            aria-label="다크/라이트 전환"
            onClick={() => setBg(isDark ? backgrounds.light : backgrounds.dark)}
          >
            {isDark ? "☀" : "☾"}
          </button>
        </div>
      </div>

      {/* 모든 탭을 마운트해 세션을 유지. display:none 은 WebGL 컨텍스트를 잃어
          리셋되므로, visibility 로 숨겨 크기·컨텍스트를 보존한다(겹쳐 쌓되 활성만 표시). */}
      <div className="terminal-stack">
        {tabs.map((t) => (
          <div
            key={t.id}
            className="terminal-pane"
            style={{
              visibility: t.id === activeId ? "visible" : "hidden",
              zIndex: t.id === activeId ? 1 : 0,
            }}
          >
            <PaneTree
              node={t.layout}
              tabId={t.id}
              activeTab={t.id === activeId}
              focusedPaneId={t.focusedPaneId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
