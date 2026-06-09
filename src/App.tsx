import { useEffect, useMemo, useState } from "react";
import { TerminalView } from "./components/TerminalView";
import { backgrounds, luminance, themeForBg } from "./terminal/theme";
import "./App.css";

function App() {
  // 배경색이 단일 소스. 토글은 프리셋, 색상 피커는 임의 색. 글자색은 밝기로 자동 선택.
  const [bg, setBg] = useState<string>(backgrounds.dark);
  const isDark = luminance(bg) <= 0.5;
  const theme = useMemo(() => themeForBg(bg), [bg]);

  // CSS --bg(그리드 잔여)·xterm theme.background(그리드)·OSC 11 응답이 모두 이 색을 따른다.
  useEffect(() => {
    document.documentElement.style.setProperty("--bg", bg);
  }, [bg]);

  return (
    <div className="app-root">
      {/* 오버레이 타이틀바: macOS 신호등(좌측)과 같은 라인. 드래그로 창 이동. */}
      <div className="titlebar" data-tauri-drag-region>
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
      <div className="terminal-wrap">
        <TerminalView theme={theme} />
      </div>
    </div>
  );
}

export default App;
