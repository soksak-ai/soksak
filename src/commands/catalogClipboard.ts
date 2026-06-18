// clipboard.* 명령 — 코어 클립보드 capability 를 command registry 로 노출(단일 진실).
// clipboard.read: 시스템 클립보드 텍스트 읽기(코어 clipboard_read 위임).
// clipboard.write: 시스템 클립보드 텍스트 쓰기(코어 clipboard_write 위임, self-write echo 억제는 코어 소관).
// 변경 감시(clipboard-change emit)는 플러그인이 app.clipboard.onChange 로 구독 — 명령 표면이 아니다(스트림).

import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";

export function registerClipboardCatalog(): void {
  register("clipboard.read", {
    description: "시스템 클립보드의 텍스트를 읽는다(텍스트 아니면 빈 문자열/에러). 실행 결과·복사 내용 확인용",
    params: {},
    returns: "{ text }",
    errors: ["INTERNAL"],
    examples: ["sok clipboard.read"],
    handler: async () => {
      const text = await invoke<string>("clipboard_read");
      return { text };
    },
  });

  register("clipboard.write", {
    description: "시스템 클립보드에 텍스트를 쓴다(기존 내용 덮어씀). 코어가 자기-쓰기 echo 를 1회 억제",
    params: {
      text: { type: "string", description: "클립보드에 넣을 텍스트", required: true },
    },
    returns: "{ ok }",
    danger: "inject",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok clipboard.write \'{"text":"복사할 내용"}\''],
    handler: async (p) => {
      if (typeof p.text !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "text 필요" };
      }
      await invoke("clipboard_write", { text: p.text });
      return { ok: true };
    },
  });
}
