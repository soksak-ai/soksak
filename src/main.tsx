import ReactDOM from "react-dom/client";
import App from "./App";

// StrictMode 비활성: dev 에서 effect 이중 실행 → createTerminal 이 두 번 돌며
// PTY 를 잠깐 두 번 spawn(하나는 즉시 dispose)하므로 dev 동작을 단순화한다.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
