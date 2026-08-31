import { useLayoutEffect } from "react";
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";

// Transient UI state. overlayCount counts every input-blocking DOM overlay;
// nativeOverlayCount counts only overlays whose geometry covers native surfaces.
//
// **Do not call the framework here.** Blocking the mouse on surfaces below while an overlay is
// up is the concern of a framework whose content is outside the document — content inside the
// document is already blocked by ordinary stacking. That reaction is wired by that framework
// subscribing to this counter (its adapter's install). The core stores facts only.
//
// Calling the framework during module evaluation binds it to load order — measured 2026-08-03:
// this file called invoke at module top level, and a circular load killed boot and 13 checks
// outright with "invoke is not a function". Boot ordering is also handled by the install side.
// (Background/color: the theme store state/theme.ts is the single source.)

interface UiState {
  overlayCount: number;
  nativeOverlayCount: number;
  pushOverlay: (nativeOccludes?: boolean) => void;
  popOverlay: (nativeOccludes?: boolean) => void;
  // Consent modal preview (plugin.consent.preview command) — plugin id to show for settings/checks. null = closed.
  // Rendered at App level (regardless of sidebar mount). Does not activate (check only).
  consentPreviewId: string | null;
  setConsentPreview: (id: string | null) => void;
  // Settings modal — null = closed, "general" = preferences, otherwise plugin id (deep link). Channel for the sidebar "Settings" shortcut.
  settingsSection: string | null;
  setSettingsSection: (s: string | null) => void;

  // The plugin manager, which is a modal and not a region's content. It hung off the right rail's ⚙
  // until 2026-08-16, so deleting that rail would have left no way to reach it — and a surface with
  // no way in is a surface that is gone. It opens from `plugin.manager` and from settings.
  pluginManagerOpen: boolean;
  setPluginManagerOpen: (open: boolean) => void;
}

// The store is outside the module boundary — a hot swap replacing it makes registration,
// subscriptions and screen state all new, and the side that filled it treats it as already
// filled and does not refill (empty forever).
export const useUi = moduleState("state/ui#store", () =>
  create<UiState>((set) => ({
  overlayCount: 0,
  nativeOverlayCount: 0,
  consentPreviewId: null,
  setConsentPreview: (id) => set({ consentPreviewId: id }),
  settingsSection: null,
  setSettingsSection: (s) => set({ settingsSection: s }),
  pluginManagerOpen: false,
  setPluginManagerOpen: (open) => set({ pluginManagerOpen: open }),
  pushOverlay: (nativeOccludes = true) => set((s) => ({
    overlayCount: s.overlayCount + 1,
    nativeOverlayCount: s.nativeOverlayCount + (nativeOccludes ? 1 : 0),
  })),
  popOverlay: (nativeOccludes = true) => set((s) => ({
    overlayCount: Math.max(0, s.overlayCount - 1),
    nativeOverlayCount: Math.max(0, s.nativeOverlayCount - (nativeOccludes ? 1 : 0)),
  })),
})),
);

// Registers an overlay while active — every modal, menu and dropdown holds this hook.
//
// It read "an input gate, not display control" until 2026-08-17, and nothing read the count at all:
// it was neither. A native surface is composited above the document, so no z-index puts an overlay
// over one, and one fact settles both. `surfaceShown` takes it as a layer, so what is registered
// here is what an overlay covers.
//
// Pass whether the overlay is showing when its component is mounted for the whole session. Two were
// registered unconditionally and held the count at 2 with nothing open, which parked every view in
// the window — `state.health` answers `overlays` so that is readable from outside.
export function useOverlayActive(active = true, nativeOccludes = true): void {
  const push = useUi((s) => s.pushOverlay);
  const pop = useUi((s) => s.popOverlay);
  useLayoutEffect(() => {
    if (!active) return;
    push(nativeOccludes);
    return () => pop(nativeOccludes);
  }, [active, nativeOccludes, push, pop]);
}
