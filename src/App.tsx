import { useEffect, useState } from "react";
import { TerminalView } from "./components/TerminalView";
import { backgrounds, themes, type ThemeMode } from "./terminal/theme";
import "./App.css";

function App() {
  const [mode, setMode] = useState<ThemeMode>("dark");

  // 배경은 CSS --bg 단일 소스 — 모드에 따라 한 곳만 바꾸면 그리드(투명)·잔여 모두 따라온다.
  useEffect(() => {
    document.documentElement.style.setProperty("--bg", backgrounds[mode]);
  }, [mode]);

  return (
    <div className="app-root" data-theme={mode}>
      {/* 오버레이 타이틀바: macOS 신호등(좌측)과 같은 라인. 드래그로 창 이동. */}
      <div className="titlebar" data-tauri-drag-region>
        <button
          type="button"
          className="theme-toggle"
          title={mode === "dark" ? "라이트 모드로" : "다크 모드로"}
          aria-label="테마 전환"
          onClick={() => setMode((m) => (m === "dark" ? "light" : "dark"))}
        >
          {mode === "dark" ? "☀" : "☾"}
        </button>
      </div>
      <div className="terminal-wrap">
        <TerminalView theme={themes[mode]} />
      </div>
    </div>
  );
}

export default App;
