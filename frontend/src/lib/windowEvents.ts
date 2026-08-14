import { currentWindow, type FrameworkEvent, type Unlisten } from "../framework";

// Subscribes only to events *targeted* at this window (webview). The core sends multi-window signals
// with emit_to(label), so each window must receive only its own. A global listen (framework boundary)
// receives every window's events regardless of target — a cmd-request sent with emit_to(another
// window) would also run in main's global listen, executing the command in two windows (per-window
// independence collapses). currentWindow().listen receives only "events emitted to this window", so
// emit_to targeting is isolated at the platform level — no JS-side label comparison hack.
//
// currentWindow() throws synchronously outside the framework runtime (jsdom tests), so it is wrapped
// in try (global listen rejected a promise; this one throws synchronously). Returns the unsubscribe
// function (for unmount cleanup).
/**
 * One subscription. Calling it unsubscribes, and `ready` resolves at the moment listening actually starts.
 *
 * Registration is asynchronous — the window receives events only after `listen()` has gone to the
 * framework and returned. This function returning means "registration started", not "listening".
 * Reading the two as the same thing silently drops the events that arrive in between — measured
 * 2026-08-08: a signal that replays backed-up deliveries was sent right after this function returned,
 * so even the replayed envelope went to a listener that did not exist yet and was lost again, and the
 * first command ran out its full 10 second cap.
 *
 * Unsubscribing is a plain function call (the same shape as React cleanup). Only the places that must
 * wait for listening to start read `ready`.
 */
export interface WindowSubscription {
  (): void;
  readonly ready: Promise<void>;
}

export function listenThisWindow<T>(
  event: string,
  handler: (e: FrameworkEvent<T>) => void,
): WindowSubscription {
  let off: Unlisten | null = null;
  let cancelled = false;
  let listening: Promise<void> = Promise.resolve();
  try {
    listening = currentWindow()
      .listen<T>(event, handler)
      .then((fn) => {
        // Unsubscribed mid-flight: fn()'s returned promise must be adopted into the chain (return) so a reject goes to the catch below.
        if (cancelled) {
          void fn();
          return;
        }
        off = fn;
      })
      .catch(() => {});
  } catch {
    /* No framework runtime (tests) — no subscription */
  }
  const unsubscribe = () => {
    cancelled = true;
    if (off) {
      // tauri v2 UnlistenFn is async — a TypeError from an already-released listener arrives as a
      // promise reject (the same measurement as safeListen). Neutralize both sync and async (re-unsubscribe is idempotent).
      try {
        const r = off() as unknown;
        if (r && typeof (r as Promise<unknown>).catch === "function") {
          void (r as Promise<unknown>).catch(() => {});
        }
      } catch {
        /* Already released — no-op */
      }
      off = null;
    }
  };
  return Object.assign(unsubscribe, { ready: listening }) as WindowSubscription;
}
