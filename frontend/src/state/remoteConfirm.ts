// Remote confirm orchestration (phone-link safety model — plan documents "safety model" /
// "phone-link security model"). This store holds only the **presentation state** of the desktop
// human decision. Authority is in the core (remote confirm) — this store is a thin presentation
// layer, and a decision leaves through exactly one path:
// invoke("remote_confirm_resolve", {request_id, approve}).
//
// Serial queue (RULE — symmetric with the core's serial confirm queue): even when several
// destructive requests arrive at once, the human answers one at a time. enqueue appends to the
// queue, active exposes only the queue head. resolve(approve) sends the head to the core and
// promotes the next request. A duplicate request_id (same request re-emitted) is ignored, idempotent.
//
// auto-deny display (mirror of the core TTL): with no decision the core AUTO-DENYs at
// created_at + ttl. This store only shows that TTL to the human as a countdown — the actual block
// is the core's (even if this timer is cut, destructive never runs; the core is the single
// authority). When the countdown hits 0 the head is dropped from the queue (desktop display
// cleanup) and the next is promoted — the core already AUTO-DENYed, so no resolve is needed.
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";

// Payload of the core's emit ("remote-confirm-request", …) — mirror of transport.rs ConfirmRequest.
export interface RemoteConfirmRequest {
  /// Key for resolve (issued by PendingConfirms). Sent back unchanged to remote_confirm_resolve.
  request_id: number;
  /// Which remote device made the request (display/audit).
  device_id: string;
  /// Human-readable command summary (e.g. "panel.close"). For display, not the dispatch bytes.
  command: string;
  /// Always true — only destructive takes this path (desktop confirm required).
  danger: boolean;
  /// Optional — command parameter summary (display). Shown when the core sends it, omitted otherwise.
  params?: string;
  /// Optional — TTL in seconds. Mirror of the core CONFIRM_TTL_SECS (countdown display).
  /// Falls back to the default when absent.
  ttl_secs?: number;
}

// Sink that sends a resolved decision to the core. The real app passes
// invoke("remote_confirm_resolve", …). Tests inject a recorder, so there is no Tauri dependency
// (pure queue logic only).
export type ResolveSink = (requestId: number, approve: boolean) => void;

// Default TTL in seconds — mirror of the sidecar (remote-iroh) bridge CONFIRM_TTL_SECS. Used only
// when the payload has no ttl_secs.
export const DEFAULT_CONFIRM_TTL_SECS = 120;

// ── Decision awaiter (for the remote.confirm command) ─────────────────────────────────────
// After the core was split from the sidecar: confirm authority (PendingConfirms, tokens) is in the
// sidecar; the core only renders the human modal and returns the decision to the sidecar. The
// `remote.confirm` command (catalogRemote) enqueues one request and **awaits** the human decision —
// this map is request_id ↔ the resolver of that await. When the modal's resolve/expire sends
// (request_id, approve) to the sink, the sink in wireRemoteConfirm wakes the matching resolver from
// this map (store queue logic unchanged — same serial queue semantics). Idempotent: a second
// decision is ignored.
// Outside the hot-swap boundary — when this table is replaced, the filling side treats it as
// already filled and does not fill again.
const decisionWaiters = moduleState("state/remoteConfirm#decisionWaiters", () => new Map<number, (approve: boolean) => void>());
// Registers a Promise awaiting the human decision for request_id (called by the remote.confirm
// handler). If the same id is already waiting, that wait is closed out as deny and a new one is
// registered (duplicate-request defense — zero undecided leaks).
export function awaitDecision(requestId: number): Promise<boolean> {
  const prev = decisionWaiters.get(requestId);
  if (prev) prev(false);
  return new Promise<boolean>((resolve) => {
    decisionWaiters.set(requestId, resolve);
  });
}

// Wakes the wait for request_id with a decision (called by the sink in wireRemoteConfirm).
// Unknown or already resolved is a harmless no-op.
export function deliverDecision(requestId: number, approve: boolean): void {
  const w = decisionWaiters.get(requestId);
  if (!w) return;
  decisionWaiters.delete(requestId);
  w(approve);
}

// Whether this request_id is waiting (test/audit). Display information only.
export function hasPendingDecision(requestId: number): boolean {
  return decisionWaiters.has(requestId);
}

interface RemoteConfirmState {
  /// Serial queue — only the head (index 0) is exposed to the modal. FIFO (arrival order).
  queue: RemoteConfirmRequest[];
  /// Sink that sends a decision to the core. wireRemoteConfirm injects the real invoke;
  /// no-op while uninjected.
  sink: ResolveSink | null;
  /// Sets the decision sink (once at app boot). Tests inject a recorder.
  setSink: (sink: ResolveSink | null) => void;
  /// Puts a new confirm request on the queue. A request_id already queued is ignored, idempotent
  /// (duplicate-emit defense).
  enqueue: (req: RemoteConfirmRequest) => void;
  /// Decides the queue head — sends (request_id, approve) to the core, then drops the head
  /// (next is promoted). No-op on an empty queue.
  resolve: (approve: boolean) => void;
  /// Drops the head from the display queue on TTL expiry (the core already AUTO-DENYed — no
  /// resolve is sent). Next is promoted. Acts only when the given request_id is the current head
  /// (a stale timer cannot drop a new head).
  expire: (requestId: number) => void;
}

// The request the modal shows now (queue head). Empty queue = null, so the modal renders nothing
// (no idle footprint).
export function activeRequest(s: RemoteConfirmState): RemoteConfirmRequest | null {
  return s.queue[0] ?? null;
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the side that filled them treats them as already
// filled and never refills (empty forever).
export const useRemoteConfirm = moduleState("state/remoteConfirm#store", () =>
  create<RemoteConfirmState>((set, get) => ({
  queue: [],
  sink: null,

  setSink: (sink) => set({ sink }),

  enqueue: (req) => {
    const q = get().queue;
    // Idempotent — a re-emitted request_id (reconnect, duplicate broadcast) does not grow the queue.
    if (q.some((r) => r.request_id === req.request_id)) return;
    set({ queue: [...q, req] });
  },

  resolve: (approve) => {
    const q = get().queue;
    const head = q[0];
    if (!head) return; // empty queue — nothing to decide.
    // Send the decision to the authority (single desktop entry point). With no sink injected
    // (outside tests) the queue advances silently.
    get().sink?.(head.request_id, approve);
    set({ queue: q.slice(1) }); // drop the head — the next request becomes the head.
  },

  expire: (requestId) => {
    const q = get().queue;
    const head = q[0];
    // Apply expiry only for the current head (stale timers isolated). The core already AUTO-DENYed,
    // so the sink is not called.
    if (!head || head.request_id !== requestId) return;
    set({ queue: q.slice(1) });
  },
})),
);
