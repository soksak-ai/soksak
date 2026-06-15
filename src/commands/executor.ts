// 명령 실행기: Rust 소켓 서버가 emit 한 cmd-request 를 registry 로 실행하고
// invoke(cmd_result) 로 회신한다(요청 id 매칭). 앱 시작 시 1회 startExecutor().

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "../state/settings";
import { registerCatalog } from "./catalog";
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
  void listen<CmdRequest>("cmd-request", async (e) => {
    const { id, method, params, pane, window } = e.payload;
    // 소켓 경유 = 원격(AI/CLI) 호출 → 권한 게이트 적용 대상. emit_to 로 이 창에만 도착하므로
    // window 는 자기 창 label(라우팅 확인·명령 컨텍스트용).
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
