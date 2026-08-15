// Remote confirm command (remote.confirm) — the desktop human gate called by the remote-iroh sidecar, which
// is split out of the core. The sidecar owns the PendingConfirms authority for destructive actions (parking,
// TTL, token issuance) and delegates **only the human decision** to the core through this command (socket
// JSON-RPC blocking call). This command:
//   1. Enqueues the request onto the RemoteConfirmModal queue (a human sees device + command and answers).
//   2. **Awaits** the human decision (Approve/Deny) or TTL expiry (Deny) (event-first, zero polling).
//   3. Replies {ok:true, approve:bool} → the sidecar resolves its own PendingConfirms with that decision.
//
// Security invariant (plan §1.3 / REMOTE-IROH §1): the phone cannot self-approve — the decision comes only
// from this desktop human modal. The danger gate (remote permission policy) still applies (remote call →
// setPermissionGate). No decision, no modal shown, permission denied, and TTL expiry all reduce to Deny
// (fail-closed). No token or execution logic in the core — the sidecar owns that floor.
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
        description: tmsg("cmd.remote.confirm.param.request_id"),
      },
      device_id: {
        type: "string",
        required: true,
        description: tmsg("cmd.remote.confirm.param.device_id"),
      },
      command: {
        type: "string",
        required: true,
        description: tmsg("cmd.remote.confirm.param.command"),
      },
      danger: {
        type: "boolean",
        description: tmsg("cmd.remote.confirm.param.danger"),
      },
      params: {
        type: "string",
        description: tmsg("cmd.remote.confirm.param.params"),
      },
      ttl_secs: {
        type: "number",
        description: tmsg("cmd.remote.confirm.param.ttl_secs"),
      },
    },
    returns: "{ approve }",
    message: (d) =>
      d.approve ? tmsg("msg.remote.confirm.approved") : tmsg("msg.remote.confirm.denied"),
    examples: [
      'remote.confirm \'{"request_id":42,"device_id":"iphone-15","command":"pane.close","danger":true,"ttl_secs":30}\'',
    ],
    danger: "destructive",
    handler: async (p) => {
      const requestId = p.request_id as number;
      const ttlSecs =
        typeof p.ttl_secs === "number" ? (p.ttl_secs as number) : DEFAULT_CONFIRM_TTL_SECS;

      // Wait for the human decision (modal resolve/deny wakes it through sink → deliverDecision).
      const decision = awaitDecision(requestId);

      // Enqueue — the modal shows the head only (serial queue). The decision arrives when the human presses Approve/Deny.
      useRemoteConfirm.getState().enqueue({
        request_id: requestId,
        device_id: p.device_id as string,
        command: p.command as string,
        params: typeof p.params === "string" ? (p.params as string) : undefined,
        danger: true,
        ttl_secs: ttlSecs,
      });

      // TTL expiry → Deny (mirrors the select! timeout in the sidecar serve loop; no decision reduces to no
      // execution). If the human decision comes first this timer is harmless (deliverDecision is idempotent —
      // the second decision is ignored). The modal's expire timer drops the display queue (store untouched).
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
