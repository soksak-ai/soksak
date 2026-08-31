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
import { contentViewHost, lastAppliedSurfaces } from "./contentViews";
import { emitPluginEvent } from "../plugins/hooks";
import { nextFrame } from "./nextFrame";
import { dropParkedPicture, holdParkedPicture, releaseParkedPicture } from "./parkedPicture";
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
// Layout motion stays in the compositor transaction. Hiding every surface during motion created a
// blank target when an inactive native view became active: there were no visible pixels to capture.
// The live surface therefore follows the applied frame while the rail and panes move. Overlay
// occlusion remains different because a native child cannot be ordered under a DOM modal.
//
// CSS hides these layers separately, but the native layer is outside CSS, so the judgment is
// collected into one expression.
export function resolveViewVisibility(
  workspaceActive: boolean,
  spaceActive: boolean,
  tabActive: boolean,
  overlayed: boolean,
  traveling: boolean,
): Readonly<{
  contentVisible: boolean;
  surfaceVisible: boolean;
  occluded: boolean;
  moving: boolean;
  reason: "visible" | "inactive-chain" | "overlay" | "layout-motion" | "overlay+layout-motion";
}> {
  const contentVisible = workspaceActive && spaceActive && tabActive;
  const reason = !contentVisible
    ? "inactive-chain"
    : overlayed && traveling
      ? "overlay+layout-motion"
      : overlayed
        ? "overlay"
        : traveling
          ? "layout-motion"
          : "visible";
  return {
    contentVisible,
    surfaceVisible: contentVisible && !overlayed,
    occluded: overlayed,
    moving: traveling,
    reason,
  };
}

export type ViewPresentation = ReturnType<typeof resolveViewVisibility>;

export function surfaceShown(
  workspaceActive: boolean,
  spaceActive: boolean,
  tabActive: boolean,
  overlayed: boolean,
  traveling: boolean,
): boolean {
  return resolveViewVisibility(
    workspaceActive,
    spaceActive,
    tabActive,
    overlayed,
    traveling,
  ).surfaceVisible;
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
  dim: number = 0,
): PluginViewSurfacePlacement {
  if (visible) {
    return { desiredVisible: true, dim, topology: "visible", declaredPaneFrame: null };
  }
  if (exclusive) {
    return {
      desiredVisible: false,
      dim,
      topology: "exclusive-hidden",
      declaredPaneFrame: { x: 0, y: 0, w: 0, h: 0 },
    };
  }
  return { desiredVisible: false, dim, topology: "retained-hidden", declaredPaneFrame: null };
}

/**
 * The declaration sent by a plugin is the applied native inventory, not the overlay parking
 * transaction. An overlay must first photograph the still-applied surface and only then hide it
 * through commitViewPresentation. Feeding surfaceVisible here lets the declaration hide the
 * surface during render, before that photograph can be taken.
 */
export function viewSurfacePlacementForPresentation(
  presentation: ViewPresentation,
  exclusive: boolean,
  parkedPictureHeld: boolean,
  dim: number = 0,
): PluginViewSurfacePlacement {
  const appliedVisible = presentation.surfaceVisible
    || (presentation.contentVisible && !parkedPictureHeld);
  return viewSurfacePlacement(appliedVisible, exclusive, dim);
}

// Outside the hot swap boundary — a new table here leaves the filling side treating it as already filled and never refilling.
const presentationByView = moduleState("lib/viewPark#presentationByView", () => new Map<string, string>());
export function commitViewPresentation(viewId: string, presentation: ViewPresentation): void {
  const key = `${presentation.surfaceVisible}:${presentation.reason}`;
  if (presentationByView.get(viewId) === key) return;
  presentationByView.set(viewId, key);
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
    emitPluginEvent("view.parked", { viewId, parked: !presentation.surfaceVisible });
    return;
  }
  const commit = () =>
    void contentViewHost()
      .visible(label, presentation.surfaceVisible)
      .catch((e: unknown) => {
        // Not swallowed — a parking that did not happen shows up only as "the previous browser does
        // not disappear", and there is no path back from that symptom to this site.
        console.warn(`[viewPark] parking commit failed: ${viewId} visible=${presentation.surfaceVisible}`, e);
      });
  if (presentation.surfaceVisible) {
    // The picture goes when the page is actually back, not when it was asked for. Dropping it at
    // the request leaves the pane with neither for as long as the commit takes — measured
    // 2026-08-17, one reading of a blank pane on the way back.
    commit();
    void whenSurfaceIsBack(label).finally(() => {
      if (presentationByView.get(viewId) === key) releaseParkedPicture(viewId);
    });
  } else if (presentation.contentVisible) {
    // The picture is taken **before** the surface goes, because a surface that is already hidden has
    // nothing to photograph. Nothing drawn in the document can be put over a surface, so a card or a
    // travelling rail can only be shown by taking the surface off the screen — and a pane that goes
    // blank is what a person reads as a view that failed. The picture is what stays in its place.
    void holdParkedPicture(viewId, label)
      .then((captured) => {
        // A surface without a picture has no document stand-in. Hiding it would turn an overlay
        // into a blank pane, so it remains applied and the failure stays observable in the picture
        // failure status. Only a successful capture authorizes the visibility transition.
        if (presentationByView.get(viewId) !== key) {
          releaseParkedPicture(viewId);
        } else if (captured) {
          commit();
        }
      })
      .catch((e: unknown) => {
        console.warn(`[viewPark] parking a picture failed: ${viewId}`, e);
      });
  } else {
    // Another tab or space owns these pixels. A stand-in for this view would cover that owner.
    releaseParkedPicture(viewId);
    commit();
  }
  emitPluginEvent("view.parked", { viewId, parked: !presentation.surfaceVisible });
}

/** Reclaims state when a view closes permanently (prevents map growth). */
export function dropViewVisibility(viewId: string): void {
  presentationByView.delete(viewId);
  dropParkedPicture(viewId);
}

/** How long the picture is held waiting for the page to be back on the screen. */
const BACK_ON_SCREEN_LIMIT_MS = 1_000;

/**
 * Waits until the native layer reports this surface visible.
 *
 * The picture goes when the page is actually back, not when it was asked for: dropping it at the
 * request leaves the pane with neither for as long as the commit takes — measured 2026-08-17, one
 * reading of a blank pane on the way back, between the picture being dropped and the surface being
 * applied. What is read is the answer to the last commit, which costs no round trip of its own.
 */
async function whenSurfaceIsBack(label: string): Promise<void> {
  const until = Date.now() + BACK_ON_SCREEN_LIMIT_MS;
  for (;;) {
    if (lastAppliedSurfaces().surfaces.some((surface) => surface.id === label && surface.visible)) return;
    if (Date.now() >= until) return;
    await nextFrame();
  }
}
