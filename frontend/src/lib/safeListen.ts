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

/** Subscribe to a global event (broadcast reception). Returns an idempotent, safe disposer. */
export function safeListen<T>(
  event: string,
  handler: (e: FrameworkEvent<T>) => void,
): () => void {
  let un = () => {};
  let disposed = false;
  const safeUnlisten = (u: () => void) => {
    try {
      // tauri v2's UnlistenFn is async internally — the TypeError from an already-released
      // listener arrives as a reject of the returned promise, not a synchronous throw (measured
      // stack: _unlisten async → unhandledrejection → boot.error). Both the sync and async paths
      // must be neutralized for re-disposal to be idempotent.
      const r = u() as unknown;
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        void (r as Promise<unknown>).catch(() => {});
      }
    } catch {
      // Already-released listener (tauri internal map cleared) — re-disposal is a no-op.
    }
  };
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
