// Remote confirm dev-only mock trigger — opens RemoteConfirmModal without a live phone or
// pairing, so visual verification (window.snapshot) is possible. Installed in development
// builds only, gated on import.meta.env.DEV; in a production bundle (DEV=false) it is a no-op
// (no global is attached — no footprint).
//
// Safety: this only enqueues a mock request into the presentation-layer queue — it does not
// touch confirm authority (PendingConfirms in the remote-iroh sidecar). Approve/Deny runs
// deliverDecision in the sink, and no remote.confirm handler waits on a mock request_id, so it
// is a harmless no-op. The dev trigger imitates modal display only and has zero effect on
// execution authority (not a phone bypass path — reachable from the desktop dev console only).
import { moduleState } from "../lib/moduleState";
import { useRemoteConfirm, type RemoteConfirmRequest } from "./remoteConfirm";

// Type of window.__soksakMockRemoteConfirm (optional argument overrides the displayed values).
type MockFn = (overrides?: Partial<RemoteConfirmRequest>) => void;

declare global {
  interface Window {
    __soksakMockRemoteConfirm?: MockFn;
  }
}

// Outside the hot-swap boundary — new values here drop the "already done" record together with
// the lazy-init and unsubscribe slots, and the filling side never fills again.
const ms = moduleState("state/remoteConfirmDev#state", () => ({
  nextMockId: 900000, // High band, no overlap with core request_id (from 1) — plainly a mock.
}));

// Called once at app boot — installs window.__soksakMockRemoteConfirm under DEV, otherwise a no-op. Returns the dispose function.
export function installRemoteConfirmDevTrigger(): () => void {
  if (!import.meta.env.DEV) return () => {};
  if (typeof window === "undefined") return () => {};

  const mock: MockFn = (overrides) => {
    const req: RemoteConfirmRequest = {
      request_id: ms.nextMockId++,
      device_id: "iPhone-mock-7F3A",
      command: "panel.close",
      params: '{ "side": "left" }',
      danger: true,
      ttl_secs: 120,
      ...overrides,
    };
    useRemoteConfirm.getState().enqueue(req);
  };

  window.__soksakMockRemoteConfirm = mock;
  return () => {
    if (window.__soksakMockRemoteConfirm === mock) {
      delete window.__soksakMockRemoteConfirm;
    }
  };
}
