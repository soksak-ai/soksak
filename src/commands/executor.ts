// 명령 실행기: Rust 소켓 서버가 emit 한 cmd-request 를 registry 로 실행하고
// invoke(cmd_result) 로 회신한다(요청 id 매칭). 앱 시작 시 1회 startExecutor().

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { registerCatalog } from "./catalog";
import { execute } from "./registry";

interface CmdRequest {
  id: number;
  method: string;
  params?: Record<string, unknown> | null;
  pane?: string | null;
}

let started = false;

export function startExecutor(): void {
  if (started) return;
  started = true;
  registerCatalog();
  void listen<CmdRequest>("cmd-request", async (e) => {
    const { id, method, params, pane } = e.payload;
    const result = await execute(method, params ?? {}, {
      pane: pane ?? undefined,
    });
    invoke("cmd_result", { id, result }).catch((err) =>
      console.error("cmd_result 회신 실패:", err),
    );
  });
}
