import ReactDOM from "react-dom/client";
import App from "./App";
import { startExecutor } from "./commands/executor";
import { startBrowserGc } from "./lib/browserGc";
import { initPluginHost } from "./plugins/host";
import { ensureDefaultWorkspace, validateProjectRoot } from "./lib/workspace";
import { paneSpawnInfo, useSessions } from "./state/sessions";
import { useSettings } from "./state/settings";
import { setSpawnOptionsProvider } from "./terminal/paneHosts";
import "./assets/fonts.css";

// pane 별 spawn 옵션(프로젝트 root → cwd, 셸, 첫 pane → 자동 실행 명령) —
// 렌더 전 등록이 규칙이다: 첫 렌더 커밋 중 PaneLeaf ref 가 즉시 spawn 하므로
// effect(마운트 후) 등록은 첫 터미널을 cwd 없이(홈) 시작시킨다(실측 사고).
setSpawnOptionsProvider((paneId) => {
  const info = paneSpawnInfo(useSessions.getState().tabs, paneId);
  return { cwd: info.cwd, shell: info.shell, initialCommand: info.command };
});

// AI 명령 인터페이스: 카탈로그 등록 + 소켓 요청 실행기(앱 수명 동안 1회).
startExecutor();
// 브라우저 child 웹뷰 고아 회수(불변식 검증 — 이벤트 기반, 폴링 없음).
startBrowserGc();

// 부트(P3): 첫 프로젝트 루트(~/.soksak/projects/project1)를 준비한 뒤 렌더 —
// 루트 없는 프로젝트는 존재 불가(P1)라 앱은 루트가 준비된 후 시작한다.
// 순서 보장: 플러그인 호스트(동의된 플러그인 재활성화)가 먼저다 — 이벤트
// (project.created 등)는 리스너가 등록된 후에 발화해야 유실되지 않는다
// (신규 환경에서 첫 프로젝트의 git init 이 유실되던 사고의 원인).
// 실패 시에도 렌더는 진행(프로젝트 0개 = 부트 실패만의 예외 상태, 사유는 콘솔).
async function boot(): Promise<void> {
  try {
    await initPluginHost();
  } catch (e) {
    console.error("플러그인 호스트 초기화 실패:", e);
  }
  try {
    // 사용자가 지정한 기본 프로젝트(설정 영속)가 있으면 그 루트로 시작 —
    // 무효(삭제됨/홈 등)면 사유를 콘솔에 남기고 project1 로 폴백.
    let root: string | null = null;
    const preferred = useSettings.getState().defaultProjectRoot;
    if (preferred) {
      try {
        root = await validateProjectRoot(preferred);
      } catch (e) {
        console.error("기본 프로젝트 루트 무효 — project1 폴백:", e);
      }
    }
    root ??= await ensureDefaultWorkspace("project1");
    useSessions.getState().bootstrapFirstProject(root);
  } catch (e) {
    console.error("기본 프로젝트 루트 준비 실패:", e);
  }
  // StrictMode 비활성: dev 에서 effect 이중 실행 → createTerminal 이 두 번 돌며
  // PTY 를 잠깐 두 번 spawn(하나는 즉시 dispose)하므로 dev 동작을 단순화한다.
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />,
  );
}

void boot();
