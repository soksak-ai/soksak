import ReactDOM from "react-dom/client";
import App from "./App";
import { startExecutor } from "./commands/executor";
import { initPluginHost } from "./plugins/host";
import "./assets/fonts.css";

// AI 명령 인터페이스: 카탈로그 등록 + 소켓 요청 실행기(앱 수명 동안 1회).
startExecutor();
// 플러그인 호스트: 이벤트 훅 + 스캔 + 동의된 플러그인 재활성화(앱 수명 동안 1회).
void initPluginHost();

// StrictMode 비활성: dev 에서 effect 이중 실행 → createTerminal 이 두 번 돌며
// PTY 를 잠깐 두 번 spawn(하나는 즉시 dispose)하므로 dev 동작을 단순화한다.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
