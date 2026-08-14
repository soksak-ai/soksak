// notify.* notification commands — exposes OS notifications (tauri-plugin-notification) through
// the command registry (single truth). Scheduler reminders and utterance notifications take this
// path. Click → command execution is handled by the deep link (soksak[-env]://cmd/<name>) — the
// platform has no per-notification click action for desktop notifications, so the deep link
// fills that slot (core deeplink.rs on_open_url).

import { invoke } from "../framework";
import { tmsg } from "../i18n";
import { register } from "./registry";

export function registerNotifyCatalog(): void {
  register("notify.show", {
    description:
      "Show an OS desktop notification (title + body). Behaves like a push notification when the window is not focused. Clicking runs the deep link this notification carries — pass it as `deepLink` (soksak[-env]://cmd/<name>?<query>).",
    triggers: { ko: "알림 보내기 푸시 통지 데스크톱알림" },
    params: {
      title: { type: "string", description: "Notification title", required: true },
      body: { type: "string", description: "Notification body text", required: true },
      deepLink: {
        type: "string",
        description: "Deep link to run when the notification is clicked (soksak[-env]://cmd/<name>)",
        required: false,
      },
    },
    returns: "{ ok, handle }",
    message: () => tmsg("msg.notify.show"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['notify.show \'{"title":"Deploy done","body":"The prod deploy finished"}\''],
    handler: async (p) => {
      if (typeof p.title !== "string" || typeof p.body !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.notify.show.titleBodyRequired") };
      }
      // Forward the click payload unchanged — the core validates whether it is a command URI (otherwise `ran:false`).
      const r = await invoke<{ handle: number } | null>("notify_show", {
        title: p.title,
        body: p.body,
        extra: { deepLink: typeof p.deepLink === "string" ? p.deepLink : null },
      });
      // Return the handle — without it a shown notification cannot be addressed again.
      return { ok: true, data: { handle: r?.handle ?? null } };
    },
  });

  // Notification activation — the same door a human finger uses.
  //
  // Activation does one thing (hand the payload back to its owner) and the framework holds that
  // one place. Writing it again here makes two paths, and then this command can pass while the
  // click is dead.
  //
  // This is not a test back door. It opens no new door; it puts an address on the door that
  // already exists — an unnamed event cannot be invoked, and what cannot be invoked cannot be
  // called working.
  register("notify.activate", {
    description:
      "Activate a notification previously shown by `notify.show`, using its `handle`. Runs exactly what an OS click runs.",
    triggers: { ko: "알림 누르기 알림 활성화 클릭" },
    params: {
      handle: { type: "number", description: "Handle returned by notify.show", required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.notify.activate"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['notify.activate \'{"handle":1}\''],
    handler: async (p) => {
      if (typeof p.handle !== "number") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.notify.activate.handleRequired") };
      }
      await invoke("notify_activate", { handle: p.handle });
      return { ok: true };
    },
  });
}
