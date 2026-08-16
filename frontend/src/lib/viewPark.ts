// Effective visibility of a view body slot (sheet active && tab active) — owned by the core in one
// place (the native-layer extension of R12).
// CSS parkedStyle covers the DOM layer only. The core handles the native layer directly:
//   ① Show/hide the core-owned child webview (browserLabel scheme) — hiding also returns the
//      responder (webview_visible), and the core command silently no-ops for an unknown label.
//   ② Notify plugins of the view.parked fact — a plugin owning an engine surface matches its
//      show/hide and re-snap to that fact. Each plugin's viewport guessing (IntersectionObserver)
//      and re-snap races are replaced by one rule.
// Idempotent: re-committing the same state is a no-op — calling it every render costs only on change.
import { moduleState } from "../lib/moduleState";
import { contentViewHost } from "./contentViews";
import { emitPluginEvent } from "../plugins/hooks";
import { surfaceLabelOfView } from "./surfaceLabels";
import { parkedStyle } from "./layerPark";
import type { PluginViewSurfacePlacement } from "../plugins/viewPresentationHost";

// Whether a view is actually visible — true **only when every layer is true**: the workspace is
// active, that space is active within the workspace, that view is the active tab within the space,
// and no overlay is drawn over it. Miss one layer and the core receives "visible" for an invisible
// view and leaves the native child (browser webview, engine surface) on screen — that was exactly
// the defect where the previous workspace's browser stayed up after a workspace switch (missing
// workspace layer).
//
// The overlay layer is the same defect at the window level. A native surface is composited above the
// document, so no z-index orders it under a modal: the plugin manager opened and two browser pages
// drew over the card, measured 2026-08-17. A surface record has `visible` and `layer`, and the core
// already answers a view about its own visibility, so the fact is one term of this expression rather
// than a rule about modals.
//
// CSS hides these layers separately, but the native layer is outside CSS, so the judgment is
// collected into one expression.
export function surfaceShown(
  workspaceActive: boolean,
  spaceActive: boolean,
  tabActive: boolean,
  overlayed: boolean,
): boolean {
  return workspaceActive && spaceActive && tabActive && !overlayed;
}

/**
 * DOM lifetime contract of a view slot. Normally an inactive tab keeps its box and only visibility
 * is turned off, but in an exclusive state such as maximize, where only one surface may exist in
 * the layout, the excluded slots are removed from the composition tree with display:none. The DOM
 * and the plugin instance are not unmounted, and layout.reflow on the restore commit delivers the
 * current slot size again.
 */
export function viewSurfaceStyle(visible: boolean, exclusive: boolean) {
  return {
    ...parkedStyle(visible),
    display: exclusive && !visible ? "none" : undefined,
  };
}

/**
 * Layout topology owns whether a hidden surface retains its box or leaves composition entirely.
 * Exclusive removal therefore declares its exact parking frame; presentation never waits for a
 * ResizeObserver callback that `display:none` does not promise to produce.
 */
export function viewSurfacePlacement(
  visible: boolean,
  exclusive: boolean,
): PluginViewSurfacePlacement {
  if (visible) {
    return { desiredVisible: true, topology: "visible", declaredPaneFrame: null };
  }
  if (exclusive) {
    return {
      desiredVisible: false,
      topology: "exclusive-hidden",
      declaredPaneFrame: { x: 0, y: 0, w: 0, h: 0 },
    };
  }
  return { desiredVisible: false, topology: "retained-hidden", declaredPaneFrame: null };
}

// Outside the hot swap boundary — a new table here leaves the filling side treating it as already filled and never refilling.
const visibleByView = moduleState("lib/viewPark#visibleByView", () => new Map<string, boolean>());
export function commitViewVisibility(viewId: string, visible: boolean): void {
  if (visibleByView.get(viewId) === visible) return;
  visibleByView.set(viewId, visible);
  // **Go through the host.** Calling the name directly gets that name rejected as delegated
  // (FRAMEWORK_DELEGATED) on a framework whose content is inside the DOM, and no parking happens at
  // all — the previous view stays up after a tab switch and the new view is invisible (measured
  // 2026-07-30: 301 such rejections in the request ledger).
  // contentViews is the single owner of how the app presents content.
  //
  // The label is read off the declaration, not rebuilt. Rebuilding needs the surface's kind, which
  // is the plugin's word, and a rebuild agrees with itself about a name the plugin never used — the
  // host then refuses a label nobody created and the parking silently does not happen.
  const label = surfaceLabelOfView(viewId);
  if (label === null) {
    // Most views declare no surface — a terminal, a plugin body. There is nothing to park, and the
    // event is still emitted because the view's parked state did change.
    emitPluginEvent("view.parked", { viewId, parked: !visible });
    return;
  }
  void contentViewHost()
    .visible(label, visible)
    .catch((e: unknown) => {
      // Not swallowed — a parking that did not happen shows up only as "the previous browser does
      // not disappear", and there is no path back from that symptom to this site.
      console.warn(`[viewPark] parking commit failed: ${viewId} visible=${visible}`, e);
    });
  emitPluginEvent("view.parked", { viewId, parked: !visible });
}

/** Reclaims state when a view closes permanently (prevents map growth). */
export function dropViewVisibility(viewId: string): void {
  visibleByView.delete(viewId);
}
