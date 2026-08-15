// Zoom intent router (plan golden-swinging-lynx) — "focus determines the scope".
// DOM focus inside a view routes to that view's zoom hook (the view responds by its own
// convention: terminal = font, browser = page zoom); no view focus (frame selection = a chrome
// click put focus on body) zooms the whole window.
// Frame selection is not a new state but the natural state of DOM focus — a chrome click enters it.
import { framework } from "../framework";
import { deepActiveElement, viewContainerOf } from "../commands/catalogDom";
import { emitPluginEvent } from "../plugins/hooks";
import { zoomFocusedView } from "../plugins/viewFocus";
import { useSettings } from "../state/settings";

export type ZoomAction = "in" | "out" | "reset";

/** Platform primary modifier — macOS=⌘(metaKey), Windows/Linux=Ctrl. The zoom key grammar shared by the 3 platforms. */
export function isPrimaryModifier(
  e: { metaKey: boolean; ctrlKey: boolean },
  platform: string = navigator.platform,
): boolean {
  return /mac/i.test(platform) ? e.metaKey : e.ctrlKey;
}

export const ZOOM_STEP = 0.1;

/** Window zoom factor contract — 0.5..2.0, rounded to 0.1 steps (prevents float accumulation). */
export function clampWindowZoom(factor: number): number {
  return Math.min(2, Math.max(0.5, Math.round(factor * 10) / 10));
}

interface ZoomDeps {
  /** View zoom delegation — false when the hook is not implemented (it still does not leak into window zoom: opt-in convention). */
  zoomView(viewId: string, action: ZoomAction): boolean;
  stepWindow(action: ZoomAction): void;
}

/** One step of whole-window zoom — the setting (windowZoom) is the single truth for the value and
 * the native side applies it in one batch (main webview + every child webview at the same factor =
 * "one value, all consumers"). */
export function stepWindowZoom(action: ZoomAction): void {
  const s = useSettings.getState();
  const next =
    action === "reset"
      ? 1
      : clampWindowZoom(s.windowZoom + (action === "in" ? ZOOM_STEP : -ZOOM_STEP));
  s.setWindowZoom(next);
  void applyWindowZoom(next).catch((error) => {
    console.error("window zoom apply failed:", error);
  });
}

export async function applyWindowZoom(factor: number): Promise<void> {
  // No framework branching here — there is one value, and how that value is applied to the screen
  // is the framework's part (the `setWindowZoom` contract). Calling one side's command name here
  // makes the other side reject it on every boot (measured 2026-08-08: one reject line per boot in
  // the Electron activity feed).
  await framework.setWindowZoom(factor);
  // Broadcast to surfaces outside the webview (CEF engines and such) — each engine plugin applies the window×view composed factor to its own surface.
  emitPluginEvent("window.zoom", { factor });
}

/** Waits until the boot first-frame barrier has applied the stored single zoom truth to native. */
export function applySavedWindowZoom(): Promise<void> {
  return applyWindowZoom(useSettings.getState().windowZoom);
}

const defaultDeps: ZoomDeps = {
  zoomView: zoomFocusedView,
  stepWindow: stepWindowZoom,
};

/** General fallback for views with no hook (§Zoom) — steps the container's body font variable. A
 * view that declares its body font with this variable (file viewers and such) gets zoom for free,
 * and it is harmless to views that do not consume it (opt-in). The row grid is untouched because
 * the only consumption point of the variable is the body (zoom invariant).
 *
 * Two names: the canonical one is --tab-font-size (vocabulary standard — an instance is a tab), and
 * the old name --view-font-size is written with the same value. This variable is a contract surface
 * published by docs/PLUGIN-CONTRACT.md and a plugin declaring the old name
 * already exists — writing only one of them kills zoom in that view. Reads prefer the new name and
 * fall back to the old one (covers a plugin that supplied the initial value inline).
 * Removal condition: every plugin declaring this variable migrates to --tab-font-size (verified by
 * grep returning 0 in each plugin repo) plus a PLUGIN-CONTRACT document update. Then the two old
 * name set/get lines are deleted. */
export const VIEW_FONT_BASE = 13;

const TAB_FONT_VAR = "--tab-font-size";
const TAB_FONT_VAR_LEGACY = "--view-font-size";

export function stepContainerFontVar(host: HTMLElement, action: ZoomAction): void {
  const raw =
    host.style.getPropertyValue(TAB_FONT_VAR) ||
    host.style.getPropertyValue(TAB_FONT_VAR_LEGACY);
  const current = raw ? Number.parseFloat(raw) : VIEW_FONT_BASE;
  const next =
    action === "reset"
      ? VIEW_FONT_BASE
      : Math.max(6, Math.min(40, current + (action === "in" ? 1 : -1)));
  host.style.setProperty(TAB_FONT_VAR, `${next}px`);
  host.style.setProperty(TAB_FONT_VAR_LEGACY, `${next}px`);
}

export function routeZoom(action: ZoomAction, deps: ZoomDeps = defaultDeps): void {
  const active = deepActiveElement();
  const host = viewContainerOf(active);
  const viewId = host?.dataset.tabId ?? null;
  if (viewId && host) {
    if (!deps.zoomView(viewId, action)) stepContainerFontVar(host, action);
    return;
  }
  deps.stepWindow(action);
}
