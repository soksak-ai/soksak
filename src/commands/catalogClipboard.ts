// clipboard.* 명령 — 코어 클립보드 capability 를 command registry 로 노출(단일 진실).
// clipboard.read: 시스템 클립보드 텍스트 읽기(코어 clipboard_read 위임).
// clipboard.write: 시스템 클립보드 텍스트 쓰기(코어 clipboard_write 위임, self-write echo 억제는 코어 소관).
// 변경 감시(clipboard-change emit)는 플러그인이 app.clipboard.onChange 로 구독 — 명령 표면이 아니다(스트림).

import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";

export function registerClipboardCatalog(): void {
  register("clipboard.read", {
    description: "Read the current text from the system clipboard. Returns an empty string when the clipboard holds non-text content. Use to inspect a command result or the last copied value.",
    triggers: { ko: "클립보드 읽기 복사내용 붙여넣기확인" },
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
    description: "Write text to the system clipboard, overwriting existing content. The core suppresses the self-write echo event once to prevent feedback loops.",
    triggers: { ko: "클립보드 쓰기 복사 클립보드저장" },
    params: {
      text: { type: "string", description: "Text to place in the clipboard", required: true },
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
