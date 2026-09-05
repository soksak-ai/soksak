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

/** A box an overlay covers, in absolute CSS points. */
export type OverlayArea = { left: number; top: number; right: number; bottom: number };

function sameArea(left: OverlayArea | null, right: OverlayArea | null): boolean {
  if (left === null || right === null) return left === right;
  return left.left === right.left && left.top === right.top
    && left.right === right.right && left.bottom === right.bottom;
}

function dropOneArea(
  areas: readonly (OverlayArea | null)[],
  area: OverlayArea | null,
): readonly (OverlayArea | null)[] {
  const index = areas.findIndex((held) => sameArea(held, area));
  if (index < 0) return areas;
  return [...areas.slice(0, index), ...areas.slice(index + 1)];
}

interface UiState {
  overlayCount: number;
  nativeOverlayCount: number;
  /** What each open native-occluding overlay covers. A null entry covers the window. */
  nativeOverlayAreas: readonly (OverlayArea | null)[];
  pushOverlay: (nativeOccludes?: boolean, area?: OverlayArea | null) => void;
  popOverlay: (nativeOccludes?: boolean, area?: OverlayArea | null) => void;
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

  // A press the document did not deliver — one on a native surface, which is composited above the
  // document and takes the pointer before it. A DOM overlay hears presses through the document, so
  // it read such a press as no press at all: the program menu stayed open over a terminal that had
  // just been clicked (measured 2026-09-05). Counted here; an overlay reads a change as a press
  // outside itself.
  nativePress: number;
  noteNativePress: () => void;
}

// The store is outside the module boundary — a hot swap replacing it makes registration,
// subscriptions and screen state all new, and the side that filled it treats it as already
// filled and does not refill (empty forever).
export const useUi = moduleState("state/ui#store", () =>
  create<UiState>((set) => ({
  overlayCount: 0,
  nativeOverlayAreas: [],
  nativeOverlayCount: 0,
  consentPreviewId: null,
  setConsentPreview: (id) => set({ consentPreviewId: id }),
  settingsSection: null,
  setSettingsSection: (s) => set({ settingsSection: s }),
  pluginManagerOpen: false,
  setPluginManagerOpen: (open) => set({ pluginManagerOpen: open }),
  nativePress: 0,
  noteNativePress: () => set((s) => ({ nativePress: s.nativePress + 1 })),
  pushOverlay: (nativeOccludes = true, area = null) => set((s) => ({
    overlayCount: s.overlayCount + 1,
    nativeOverlayCount: s.nativeOverlayCount + (nativeOccludes ? 1 : 0),
    nativeOverlayAreas: nativeOccludes ? [...s.nativeOverlayAreas, area] : s.nativeOverlayAreas,
  })),
  popOverlay: (nativeOccludes = true, area = null) => set((s) => ({
    overlayCount: Math.max(0, s.overlayCount - 1),
    nativeOverlayCount: Math.max(0, s.nativeOverlayCount - (nativeOccludes ? 1 : 0)),
    // One entry equal to what was pushed. Overlays open and close in any order, so the entry is
    // matched by its value rather than by its position.
    nativeOverlayAreas: nativeOccludes ? dropOneArea(s.nativeOverlayAreas, area) : s.nativeOverlayAreas,
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
export function useOverlayActive(
  active = true,
  nativeOccludes = true,
  /** What this overlay covers. Absent covers the window — a modal is one. */
  area: OverlayArea | null = null,
): void {
  const push = useUi((s) => s.pushOverlay);
  const pop = useUi((s) => s.popOverlay);
  // The area is a value, and an object rebuilt each render would push and pop every frame. The
  // effect runs on the area's numbers, not on the identity of the object holding them.
  const key = area ? `${area.left},${area.top},${area.right},${area.bottom}` : "";
  useLayoutEffect(() => {
    if (!active) return;
    const covered = key === "" ? null : (() => {
      const [left, top, right, bottom] = key.split(",").map(Number);
      return { left, top, right, bottom };
    })();
    push(nativeOccludes, covered);
    return () => pop(nativeOccludes, covered);
  }, [active, nativeOccludes, key, push, pop]);
}
