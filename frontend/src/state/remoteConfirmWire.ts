// Remote confirm wiring (event-first, 0 polling — RULE 7) — connects the modal's decision to the
// await inside the remote.confirm command. Since the core was split out of the remote-iroh sidecar:
// confirm authority (PendingConfirms, tokens) is in the sidecar and the core renders only the human
// modal. When the sidecar calls `remote.confirm` over the socket, that handler queues the request
// and awaits the human decision (catalogRemote). When the modal's resolve/deny sends
// (request_id, approve) to the sink, this wiring wakes that await via deliverDecision — the sidecar
// resolves its own PendingConfirms with the returned decision.
//
// Authority boundary: a decision leaves only from this desktop human modal (the phone has 0 paths
// to it). Even with this wiring broken, nothing destructive runs — the TTL in the remote.confirm
// handler reduces no-decision to Deny (fail-closed), and token/execution authority is entirely in
// the sidecar floor (remote::*).
import { useRemoteConfirm, deliverDecision } from "./remoteConfirm";

// Call once at app boot — injects the decision sink (resolves the remote.confirm await). Returns the disposer (unmount cleanup).
export function wireRemoteConfirm(): () => void {
  // Decision sink — the single desktop entry point. When the modal's resolve (approve/deny) sends
  // (request_id, approve), it wakes the await in the pending remote.confirm handler (for an unknown or already-resolved id, deliverDecision is a harmless no-op).
  useRemoteConfirm.getState().setSink((requestId, approve) => {
    deliverDecision(requestId, approve);
  });

  return () => {
    useRemoteConfirm.getState().setSink(null);
  };
}
