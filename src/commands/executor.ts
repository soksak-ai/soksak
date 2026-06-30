// 명령 실행기: Rust 소켓 서버가 emit 한 cmd-request 를 registry 로 실행하고
// invoke(cmd_result) 로 회신한다(요청 id 매칭). 앱 시작 시 1회 startExecutor().

import { invoke } from "@tauri-apps/api/core";
import { listenThisWindow } from "../lib/windowEvents";
import { useSettings } from "../state/settings";
import { registerCatalog } from "./catalog";
import { registerDebugCatalog } from "./catalogDebug";
import { registerRemoteCatalog } from "./catalogRemote";
import { registerRemoteConfirmDevCatalog } from "./catalogRemoteConfirmDev";
import { execute, setPermissionGate } from "./registry";

interface CmdRequest {
  id: number;
  method: string;
  params?: Record<string, unknown> | null;
  pane?: string | null;
  window?: string | null;
}

let started = false;

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
    const { id, method, params, pane, window } = e.payload;
    // 소켓 경유 = 원격(AI/CLI) 호출 → 권한 게이트 적용 대상. window 는 자기 창 label
    // (라우팅 확인·명령 컨텍스트용).
    const result = await execute(method, params ?? {}, {
      pane: pane ?? undefined,
      remote: true,
      window: window ? { label: window } : undefined,
    });
    invoke("cmd_result", { id, result }).catch((err) =>
      console.error("cmd_result 회신 실패:", err),
    );
  });
}
