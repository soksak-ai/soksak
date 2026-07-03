import ReactDOM from "react-dom/client";
import App from "./App";
import { startExecutor } from "./commands/executor";
import { startWebviewGc } from "./lib/webviewGc";
import { initPluginHost } from "./plugins/host";
import { initNotify } from "./lib/notify";
import { ensureDefaultWorkspace, validateProjectRoot } from "./lib/workspace";
import { currentWindowLabel } from "./lib/webviewLabels";
import { claimRoots } from "./state/projectRegistry";
import { recordRecentProject } from "./state/recentProjects";
import { useSessions } from "./state/sessions";
import { initWorkspacePersistence, respawnSavedWindows, coreStoreDeps } from "./state/workspaceBoot";
import { initViewLabelsPersistence } from "./state/viewLabels";
import { initSettingsPersistence } from "./state/settings";
import { initThemePersistence } from "./state/theme";
import { initBookmarksPersistence } from "./state/bookmarks";
import { initPluginSettingsPersistence } from "./state/pluginSettings";
import { initPluginsPersistence } from "./state/plugins";
import { useSettings } from "./state/settings";
import { startTerminalStatusBridge } from "./terminal/terminalStatus";
import "./assets/fonts.css";

// 터미널 spawn 옵션(cwd/셸/자동실행 명령)은 코어가 아니라 터미널 플러그인이 소유한다 —
// 플러그인 뷰가 마운트 시 PluginViewContext(root/command)와 자기 설정(shell)으로 직접 spawn 한다.

// AI 명령 인터페이스: 카탈로그 등록 + 소켓 요청 실행기(앱 수명 동안 1회).
startExecutor();
// 브라우저 child 웹뷰 고아 회수(불변식 검증 — 이벤트 기반, 폴링 없음).
startWebviewGc();
// 터미널 foreground 명령(셸 통합 OSC 이벤트) → 그 뷰의 running status(M5, 폴링 없음).
startTerminalStatusBridge();

// 부트(P3): 첫 프로젝트 루트(~/.soksak/projects/project1)를 준비한 뒤 렌더 —
// 루트 없는 프로젝트는 존재 불가(P1)라 앱은 루트가 준비된 후 시작한다.
// 순서 보장: 플러그인 호스트(동의된 플러그인 재활성화)가 먼저다 — 이벤트
// (project.created 등)는 리스너가 등록된 후에 발화해야 유실되지 않는다
// (신규 환경에서 첫 프로젝트의 git init 이 유실되던 사고의 원인).
// 실패 시에도 렌더는 진행(프로젝트 0개 = 부트 실패만의 예외 상태, 사유는 콘솔).
async function boot(): Promise<void> {
  // 코어 영속 상태(설정·테마·즐겨찾기·플러그인 설정·플러그인 동의/활성)를 app.data 권위 +
  // 멀티창 broadcast 로 동기화(coreSync). 동기 초기상태는 이미 ls 캐시에서 로드됨 — 여기선
  // app.data hydrate + 다른 창 변경 구독을 켠다. 플러그인 호스트(enabledIds 소비)보다 먼저.
  try {
    initSettingsPersistence(coreStoreDeps);
    initThemePersistence(coreStoreDeps);
    initBookmarksPersistence(coreStoreDeps);
    initPluginSettingsPersistence(coreStoreDeps);
    initPluginsPersistence(coreStoreDeps);
    initViewLabelsPersistence(coreStoreDeps);
  } catch (e) {
    console.error("코어 영속 동기화 초기화 실패:", e);
  }
  try {
    await initPluginHost();
  } catch (e) {
    console.error("플러그인 호스트 초기화 실패:", e);
  }
  // 알림 클릭(OS)·외부/콜드스타트 딥링크 라우팅 — command 레지스트리+플러그인 준비 후 1회.
  try {
    await initNotify();
  } catch (e) {
    console.error("알림/딥링크 초기화 실패:", e);
  }
  // 프로그래매틱 오픈(window.new{root}) — 창 생성자가 부트 지시를 URL 쿼리로 전달한다
  // (창별 JS 컨텍스트 분리의 유일한 통로). 지시가 있으면 복원보다 우선: 사용자 의도가
  // "이 창에서 그 프로젝트"이므로. claim 실패(생성↔부트 레이스)면 빈 창 → 픽커로 열화.
  const bootParams = new URLSearchParams(window.location.search);
  const initRoot = bootParams.get("root");
  // fresh=1(런타임 새 창): 스냅샷 복원 금지 — 라벨(win-<seq>) 재사용이 crash 로 남은 옛
  // 세션을 유령 복원하는 것을 차단한다(자동 저장은 켠다 — 이 창의 새 세션은 저장돼야 함).
  const freshWindow = bootParams.get("fresh") === "1";
  if (initRoot) {
    try {
      const denied = await claimRoots([initRoot]);
      if (!denied.has(initRoot)) {
        useSessions.getState().bootstrapFirstProject(initRoot);
        void recordRecentProject(initRoot, ""); // 픽커 최근 목록(명시적 열기)
      } else {
        console.warn(`[P6] 지시된 프로젝트가 다른 창에 열림 — 픽커로 열화: ${initRoot}`);
      }
    } catch (e) {
      console.error("지시된 프로젝트 부트 실패:", e);
    }
  }
  // 영속된 워크스페이스(레이아웃·탭·분할)를 먼저 복원(A5). 복원본이 있으면 기본 부트를 건너뛴다.
  // 복원본의 root 들은 이전 세션에서 검증된 경로 — 부재 시 그 프로젝트 뷰는 빈 상태로 뜨고
  // 사용자가 정리한다(여기서 fs 검증으로 전체 복원을 막지 않는다). 자동 저장 구독도 여기서 시작.
  // (initRoot 로 이미 탭이 있으면 restoreProjects 는 멱등 no-op — 자동 저장 구독만 켜진다.)
  let restored = false;
  try {
    restored = await initWorkspacePersistence({ skipRestore: freshWindow });
  } catch (e) {
    console.error("워크스페이스 영속 초기화 실패:", e);
  }
  // 멀티윈도우 리스폰(B2) — main 부트만: manifest 의 다른 창들을 라벨·프레임 그대로 되살린다.
  // await 하지 않는다 — 각 창은 독립 부트라 main 렌더를 막을 이유가 없다.
  if (!freshWindow && currentWindowLabel() === "main") {
    void respawnSavedWindows();
  }
  try {
    if (!restored && !initRoot && currentWindowLabel() === "main") {
      // 복원본 없음(main 창) — 사용자가 지정한 기본 프로젝트(설정 영속)가 있으면 그 루트로,
      // 무효면 사유를 콘솔에 남기고 project1 로 폴백.
      // 비-main 새 창은 자동 부팅하지 않는다 — 프로젝트 선택(픽커)이 선행한다(P6 UX).
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
      // P6(전역 단일 오픈): 기본 프로젝트도 점유를 지나서 연다. 다른 창이 이미 점유했으면
      // (멀티창 부트 레이스) 이 창은 빈 채로 두고 사용자가 픽커/새 프로젝트로 시작한다.
      const denied = await claimRoots([root]);
      if (!denied.has(root)) {
        useSessions.getState().bootstrapFirstProject(root);
        void recordRecentProject(root, ""); // 픽커 최근 목록(기본 부트 포함)
      } else {
        console.warn(`[P6] 기본 프로젝트가 다른 창에 열려 있음 — 빈 창 시작: ${root}`);
      }
    }
  } catch (e) {
    console.error("기본 프로젝트 루트 준비 실패:", e);
  }
  // StrictMode 비활성: dev 에서 effect 이중 실행이 플러그인 마운트/PTY spawn 을 두 번 돌려
  // 잠깐 중복 세션을 만드는 것을 피한다(dev 동작 단순화).
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />,
  );
}

void boot();
