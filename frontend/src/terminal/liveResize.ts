import { moduleState } from "../lib/moduleState";
import { listenThisWindow } from "../lib/windowEvents";

// Window live resize (edge drag) state — the native side (install_live_resize_monitor on that
// adapter's browser surface) reports start and end exactly. ResizeObserver reports only "resizing",
// never "ended", so debounce guessing makes the update late. With this signal, fit is stopped during
// the drag (0 flicker) and a 0-delay reflow runs the moment the drag is released.
//
// Multi-platform, multi-window: the signal source differs per OS, but the core emit_to's that window
// over this channel ("window-live-resize"), so each window receives only its own resize (no frontend
// filter needed).

// Outside the hot swap boundary — if these values become new, the "already done" record and the
// lazy init disappear together, and the filling side never refills.
const ms = moduleState("terminal/liveResize#state", () => ({
  liveResizing: false,
}));
// Outside the hot swap boundary — if this table becomes new, the filling side never refills because it already ran.
const endCallbacks = moduleState("terminal/liveResize#endCallbacks", () => new Set<() => void>());
// Subscribed once per app lifetime (at module load). Receives only signals emit_to'd to this window
// (a global listen would also receive another window's resize and apply it wrongly). Outside the Tauri
// runtime (jsdom in tests) it is silently ignored — that environment has no resize.
listenThisWindow<boolean>("window-live-resize", (e) => {
  const active = e.payload;
  if (active === ms.liveResizing) return;
  ms.liveResizing = active;
  // At the end: call the registered consumers (each terminal's immediate fit).
  if (!active) for (const cb of endCallbacks) cb();
});

// Whether the window is being resized by an edge drag right now.
export function isLiveResizing(): boolean {
  return ms.liveResizing;
}

// Register a callback to call the moment live resize ends. Returns the unregister function.
export function onLiveResizeEnd(cb: () => void): () => void {
  endCallbacks.add(cb);
  return () => endCallbacks.delete(cb);
}
