// 원격 confirm 커맨드(remote.confirm) — 코어에서 분리된 remote-iroh 사이드카가 호출하는 데스크톱
// 사람 게이트. 사이드카는 destructive 액션의 PendingConfirms 권위(파킹·TTL·토큰 발행)를 소유하고,
// **사람 결정만** 이 커맨드로 코어에 위임한다(소켓 JSON-RPC blocking 호출). 이 커맨드는:
//   1. RemoteConfirmModal 큐에 요청을 enqueue(사람이 device + command 를 보고 결정).
//   2. 사람 결정(Approve/Deny) 또는 TTL 만료(Deny)를 **await**(이벤트-우선, 폴링 0).
//   3. {ok:true, approve:bool} 회신 → 사이드카가 그 결정으로 자신의 PendingConfirms 를 resolve.
//
// 보안 불변(plan §1.3 / REMOTE-IROH §1): 폰은 자가승인 불가 — 결정은 오직 이 데스크톱 사람 모달에서만.
// danger-gate(원격 권한 정책)는 그대로 적용된다(remote 호출 → setPermissionGate). 무결정/모달 미표시/
// 권한 거부/TTL 만료는 전부 Deny 로 환원(fail-closed). 토큰/실행 로직은 코어에 없다 — 사이드카 floor 소유.
import { register } from "./registry";
import { tmsg } from "../i18n";
import {
  useRemoteConfirm,
  awaitDecision,
  deliverDecision,
  DEFAULT_CONFIRM_TTL_SECS,
} from "../state/remoteConfirm";

export function registerRemoteCatalog(): void {
  register("remote.confirm", {
    description:
      "Show the desktop human confirm modal for a destructive remote action and await the decision (approve/deny). Called by the remote-iroh sidecar over the socket: the sidecar owns the confirm authority (parking, TTL, token issuance) and delegates only the human decision here. The phone cannot self-approve — the decision comes only from this desktop modal. Returns { approve }.",
    triggers: { ko: "원격 destructive 데스크톱 사람 confirm 모달 승인 거부" },
    params: {
      request_id: {
        type: "number",
        required: true,
        description: "Sidecar-issued confirm id (the sidecar resolves its PendingConfirms with this).",
      },
      device_id: {
        type: "string",
        required: true,
        description: "Requesting remote device label to show.",
      },
      command: {
        type: "string",
        required: true,
        description: "Human-readable command summary to show (e.g. panel.close).",
      },
      danger: {
        type: "boolean",
        description: "Always true on this path (destructive only).",
      },
      params: {
        type: "string",
        description: "Optional params summary string to show.",
      },
      ttl_secs: {
        type: "number",
        description: "Countdown seconds before auto-deny (mirrors sidecar TTL).",
      },
    },
    returns: "{ approve }",
    message: (d) =>
      d.approve ? tmsg("msg.remote.confirm.approved") : tmsg("msg.remote.confirm.denied"),
    examples: [
      'sok remote.confirm \'{"request_id":42,"device_id":"iphone-15","command":"panel.close","danger":true,"ttl_secs":30}\'',
    ],
    danger: "destructive",
    handler: async (p) => {
      const requestId = p.request_id as number;
      const ttlSecs =
        typeof p.ttl_secs === "number" ? (p.ttl_secs as number) : DEFAULT_CONFIRM_TTL_SECS;

      // 사람 결정 대기(모달 resolve/deny 가 sink → deliverDecision 로 깨운다).
      const decision = awaitDecision(requestId);

      // 큐에 enqueue — 모달이 머리만 노출(직렬 큐). 사람이 Approve/Deny 를 누르면 결정이 도착한다.
      useRemoteConfirm.getState().enqueue({
        request_id: requestId,
        device_id: p.device_id as string,
        command: p.command as string,
        params: typeof p.params === "string" ? (p.params as string) : undefined,
        danger: true,
        ttl_secs: ttlSecs,
      });

      // TTL 만료 → Deny(사이드카 serve loop 의 select! timeout 거울, 무결정=미실행 환원). 사람 결정이
      // 먼저 오면 이 타이머는 무해(deliverDecision 이 멱등 — 두 번째 결정은 무시). 표시 큐는 모달의
      // expire 타이머가 떨어뜨린다(스토어 무수정).
      const timeout = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          deliverDecision(requestId, false); // TTL → Deny(fail-closed).
          resolve(false);
        }, ttlSecs * 1000);
      });

      const approve = await Promise.race([decision, timeout]);
      return { approve };
    },
  });
}
