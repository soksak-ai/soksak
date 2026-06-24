// 원격 confirm **dev 전용** mock 커맨드 — 라이브 폰/페어링 없이 RemoteConfirmModal 을 띄워 헤드리스
// E2E·시각 검증(`sok dev.remoteConfirmMock` → window.snapshot)을 가능케 한다(RULE 4: 노출 command
// 자가검증). import.meta.env.DEV 게이트로 **개발 빌드에서만** 등록되고, 프로덕션 번들엔 없다.
//
// 안전: 표현층 큐에 mock 요청을 **넣기만** 한다 — Rust 권위(remote::confirm)를 건드리지 않는다(폰
// 우회 경로 아님 — 데스크톱 dev 빌드에서만 도달). danger:"inject" 로 분류해 원격 정책 게이트도 거친다.
import { register } from "./registry";
import { useRemoteConfirm } from "../state/remoteConfirm";

let nextMockId = 900000; // Rust request_id(1부터)와 안 겹치는 높은 대역 — mock 임이 분명.

// 개발 빌드에서만 dev.remoteConfirmMock 을 등록. 프로덕션(DEV=false)에선 no-op(등록 0).
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
        description: "Command summary to show (default panel.close).",
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
    examples: [
      "sok dev.remoteConfirmMock",
      'sok dev.remoteConfirmMock \'{"command":"terminal.clear","device_id":"Pixel-9"}\'',
    ],
    danger: "inject",
    handler: (p) => {
      const requestId = nextMockId++;
      useRemoteConfirm.getState().enqueue({
        request_id: requestId,
        device_id: (p.device_id as string) ?? "iPhone-mock-7F3A",
        command: (p.command as string) ?? "panel.close",
        params: (p.params as string) ?? '{ "side": "left" }',
        danger: true,
        ttl_secs: (p.ttl_secs as number) ?? 120,
      });
      return { request_id: requestId };
    },
  });
}
