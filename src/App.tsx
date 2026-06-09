import { useEffect, useMemo, useState } from "react";
import { TerminalView } from "./components/TerminalView";
import { useSessions } from "./state/sessions";
import { backgrounds, luminance, themeForBg } from "./terminal/theme";
import "./App.css";

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

  const { tabs, activeId, addTab, closeTab, setActive, renameTab } =
    useSessions();
  const [editingId, setEditingId] = useState<string | null>(null);

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
            <TerminalView theme={theme} active={t.id === activeId} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
