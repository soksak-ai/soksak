import { useLayoutEffect } from "react";
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";

// Transient UI state. overlayCount: counter for how long a DOM overlay
// (modal/menu/dropdown/drag) is up (nest-safe).
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
  pushOverlay: () => void;
  popOverlay: () => void;
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
  consentPreviewId: null,
  setConsentPreview: (id) => set({ consentPreviewId: id }),
  settingsSection: null,
  setSettingsSection: (s) => set({ settingsSection: s }),
  pluginManagerOpen: false,
  setPluginManagerOpen: (open) => set({ pluginManagerOpen: open }),
  pushOverlay: () => set((s) => ({ overlayCount: s.overlayCount + 1 })),
  popOverlay: () => set((s) => ({ overlayCount: Math.max(0, s.overlayCount - 1) })),
})),
);

// Registers an overlay while mounted (while active is true) — every modal/menu/
// dropdown must use this hook (it is an input gate, not display control).
export function useOverlayActive(active = true): void {
  const push = useUi((s) => s.pushOverlay);
  const pop = useUi((s) => s.popOverlay);
  useLayoutEffect(() => {
    if (!active) return;
    push();
    return () => pop();
  }, [active, push, pop]);
}
