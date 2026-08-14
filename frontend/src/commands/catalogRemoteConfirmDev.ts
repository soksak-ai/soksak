// Remote confirm **dev-only** mock command — shows RemoteConfirmModal without a live phone or pairing, so
// headless E2E and visual verification (`sok dev.remoteConfirmMock` → window.snapshot) are possible (RULE 4:
// exposed commands self-verify). The import.meta.env.DEV gate registers it **in dev builds only**; it is absent from the production bundle.
//
// Safety: it only **enqueues** a mock request in the presentation layer — it does not touch the core
// authority (remote::confirm). Not a phone bypass: reachable only in a desktop dev build. Classified danger:"inject", so it also passes the remote policy gate.
import { moduleState } from "../lib/moduleState";
import { register } from "./registry";
import { tmsg } from "../i18n";
import { useRemoteConfirm } from "../state/remoteConfirm";

// Outside the hot-swap boundary — if these values are replaced, the "already done" record, the lazy init
// and the unsubscribe slot disappear together, and the filling side does not fill again.
const ms = moduleState("commands/catalogRemoteConfirmDev#state", () => ({
  nextMockId: 900000, // A band far above the core request_id (which starts at 1) — plainly a mock.
}));

// Registers dev.remoteConfirmMock in dev builds only. In production (DEV=false) it is a no-op, registering 0.
export function registerRemoteConfirmDevCatalog(): void {
  if (!import.meta.env.DEV) return;

  register("dev.remoteConfirmMock", {
    description:
      "DEV-ONLY: emit a mock remote destructive confirm request so the desktop RemoteConfirmModal renders without a paired phone. For visual verification and headless E2E only; does not touch the Rust confirm authority. Absent in production builds.",
    triggers: { ko: "원격 confirm mock 데스크톱 confirm 테스트 모달" },
    params: {
      device_id: {
        type: "string",
        description: "Requesting device label to show (default iPhone-mock).",
      },
      command: {
        type: "string",
        description: "Command summary to show (default pane.close).",
      },
      params: {
        type: "string",
        description: "Optional params summary string to show.",
      },
      ttl_secs: {
        type: "number",
        description: "Countdown seconds to show (default 120).",
      },
    },
    returns: "{ request_id }",
    message: (d) => tmsg("msg.dev.remoteConfirmMock", { id: Number(d.request_id) }),
    examples: [
      "dev.remoteConfirmMock",
      'dev.remoteConfirmMock \'{"command":"terminal.clear","device_id":"Pixel-9"}\'',
    ],
    danger: "inject",
    handler: (p) => {
      const requestId = ms.nextMockId++;
      useRemoteConfirm.getState().enqueue({
        request_id: requestId,
        device_id: (p.device_id as string) ?? "iPhone-mock-7F3A",
        command: (p.command as string) ?? "pane.close",
        params: (p.params as string) ?? '{ "side": "left" }',
        danger: true,
        ttl_secs: (p.ttl_secs as number) ?? 120,
      });
      return { request_id: requestId };
    },
  });
}
