// Safe subscription to global events (behind the framework boundary) — single-truth utility
// (one place per cross-cutting derivation).
//
// listen is async, so a disposal can arrive before registration completes (mid-flight disposal),
// and disposing an already-released listener makes the framework's internal map access reject with
// a TypeError (HMR module disposal, StrictMode double mount, duplicate dispose — measured: every
// window boot harvested "reject: TypeError … listeners[eventId]" as boot.error). The disposed guard
// plus try/catch that each file hand-rolled is collected here in one place.
// For window-scoped reception use lib/windowEvents.listenThisWindow (a separate utility).

import { listen, type FrameworkEvent } from "../framework";

function safeUnlisten(unlisten: () => void): void {
  try {
    const result = unlisten() as unknown;
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Already released.
  }
}

export async function safeListenReady<T>(
  event: string,
  handler: (e: FrameworkEvent<T>) => void,
): Promise<() => void> {
  const unlisten = await listen<T>(event, handler);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    safeUnlisten(unlisten);
  };
}

/** Subscribe to a global event (broadcast reception). Returns an idempotent, safe disposer. */
export function safeListen<T>(
  event: string,
  handler: (e: FrameworkEvent<T>) => void,
): () => void {
  let un = () => {};
  let disposed = false;
  listen<T>(event, handler).then(
    (u) => {
      if (disposed) safeUnlisten(u);
      else un = () => safeUnlisten(u);
    },
    () => {
      // No backend (test harness) — no subscription, disposal stays a no-op.
    },
  );
  return () => {
    disposed = true;
    un();
    un = () => {};
  };
}
