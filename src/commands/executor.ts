// 명령 실행기: Rust 소켓 서버가 emit 한 cmd-request 를 registry 로 실행하고
// invoke(cmd_result) 로 회신한다(요청 id 매칭). 앱 시작 시 1회 startExecutor().

import { invoke } from "@tauri-apps/api/core";
import { currentWindowLabel } from "../lib/webviewLabels";
import { listenThisWindow } from "../lib/windowEvents";
import { useSettings } from "../state/settings";
import { registerCatalog } from "./catalog";
import { registerDebugCatalog } from "./catalogDebug";
import { registerOrchestratorCatalog } from "./catalogOrchestrator";
import { registerRemoteCatalog } from "./catalogRemote";
import { registerRemoteConfirmDevCatalog } from "./catalogRemoteConfirmDev";
import { execute, setPermissionGate } from "./registry";

interface CmdRequest {
  id: number;
  method: string;
  params?: Record<string, unknown> | null;
  pane?: string | null;
  window?: string | null;
  // 상관 부모(대화 턴 id) — 에이전트 env SOKSAK_PARENT → sok → 소켓 요청 meta. ctx 로 관통해
  // 활동 엔트리 payload.parentId 가 된다(턴 세트 묶음).
  parent?: string | null;
}

let started = false;

// 부팅 준비 게이트 — 플러그인 활성화(initPluginHost) 완료 전에 도착한 외부 요청(스케줄러·소켓)을
// 완료 이벤트까지 지연한다. 부팅 직후 발화가 아직 등록 전인 플러그인 명령(또는 등록은 됐지만
// 의존 플러그인이 활성화 전인 핸들러)에 부딪혀 가짜 UNKNOWN_COMMAND 를 내던 레이스의 구조적
// 봉합(재시도·폴링 없음). "미등록 명령만 대기"는 부족하다 — 등록된 명령의 핸들러가 다른
// 플러그인 명령을 부르는 경우(workflow reconcile → kanban)를 놓친다. 전부 대기가 올바른 의미론.
let hostReady = false;
let resolveHostReady: (() => void) | undefined;
const hostReadyGate = new Promise<void>((resolve) => {
  resolveHostReady = resolve;
});

/** 플러그인 호스트 활성화 완료 신호 — main.tsx 가 initPluginHost() 직후 1회 호출한다. */
export function markCommandHostReady(): void {
  hostReady = true;
  resolveHostReady?.();
}

export function startExecutor(): void {
  if (started) return;
  started = true;
  registerCatalog();
  // 원격 confirm 데스크톱 사람 게이트(remote.confirm) — remote-iroh 사이드카가 destructive 결정을
  // 위임하는 라이브 커맨드. 권위(PendingConfirms·토큰)는 사이드카, 사람 결정만 코어 모달에서.
  registerRemoteCatalog();
  // dev 전용 mock 커맨드(프로덕션 번들엔 등록 0) — 라이브 폰 없이 confirm 모달 헤드리스 검증.
  registerRemoteConfirmDevCatalog();
  // dev 전용 debug.* — 스케줄러 process_lease lease e2e 검증용 held-reply(debug.sleep). 프로덕션 0.
  registerDebugCatalog();
  // 자연어 콘솔(orchestrator.*)은 컨트롤 플레인(main) 전용 — 워크스페이스 창엔 존재하지 않는
  // capability 다(UNKNOWN_COMMAND 가 정답). 소켓은 --window main 으로 명시 타겟.
  if (currentWindowLabel() === "main") registerOrchestratorCatalog();
  // 권한 게이트: 위험 분류별 정책을 설정 store 에서 읽어 allow/deny 판정.
  setPermissionGate((danger) => {
    const s = useSettings.getState();
    const policy =
      danger === "destructive" ? s.remoteDestructive : s.remoteInject;
    if (policy === "deny") {
      console.warn(`[권한] 원격 ${danger} 명령 차단(정책: deny)`);
      return false;
    }
    return true;
  });
  // 이 창에 emit_to 된 cmd-request 만 받는다(전역 listen 이면 emit_to(다른 창) 도 받아 명령이
  // 두 창에서 중복 실행 → 창별 독립 붕괴). lib/windowEvents 머리말 참조.
  listenThisWindow<CmdRequest>("cmd-request", async (e) => {
    const { id, method, params, pane, window, parent } = e.payload;
    // 호스트 미준비 = 플러그인 활성화 진행 중 — 완료까지 대기 후 실행.
    // (완료 후에도 미등록이면 그때의 UNKNOWN_COMMAND 가 진짜다.)
    if (!hostReady) await hostReadyGate;
    // 소켓 경유 = 원격(AI/CLI) 호출 → 권한 게이트 적용 대상. window 는 자기 창 label
    // (라우팅 확인·명령 컨텍스트용).
    const result = await execute(method, params ?? {}, {
      pane: pane ?? undefined,
      remote: true,
      window: window ? { label: window } : undefined,
      parent: parent ?? undefined,
    });
    invoke("cmd_result", { id, result }).catch((err) =>
      console.error("cmd_result 회신 실패:", err),
    );
  });
}
