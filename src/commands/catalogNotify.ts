// notify.* 알림 명령 — OS 알림(tauri-plugin-notification)을 command registry 로 노출(단일 진실).
// 스케줄러 reminder·발화 알림이 이 경로로 흐른다. 클릭→명령 실행은 딥링크(soksak://run?cmd=)가
// 담당한다 — 데스크톱 알림은 per-notification 클릭 액션을 플랫폼이 지원하지 않으므로 딥링크가 그
// 자리를 메운다(코어 deeplink.rs on_open_url).

import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";

export function registerNotifyCatalog(): void {
  register("notify.show", {
    description:
      "Show an OS desktop notification (title + body). Behaves like a push notification when the window is not focused. To trigger a command on click, embed a deep-link URL (soksak://run?cmd=<command>&p=<JSON>) in the body or follow-up message.",
    triggers: { ko: "알림 보내기 푸시 통지 데스크톱알림" },
    params: {
      title: { type: "string", description: "Notification title", required: true },
      body: { type: "string", description: "Notification body text", required: true },
    },
    returns: "{ ok }",
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['sok notify.show \'{"title":"배포 완료","body":"prod 배포가 끝났습니다"}\''],
    handler: async (p) => {
      if (typeof p.title !== "string" || typeof p.body !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "title·body 필요" };
      }
      await invoke("notify_show", { title: p.title, body: p.body });
      return { ok: true };
    },
  });
}
