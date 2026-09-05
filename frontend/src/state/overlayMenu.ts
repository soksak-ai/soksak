// The one overlay menu open at a time, as native-surface state.
//
// A program menu (and, later, any small popover) is composited in its own native webview surface
// above every terminal, so opening it parks nothing and its appearance and dismissal are a single
// native layer added and removed — no document-picture swap, which is what flickered on a real click
// (measured 2026-09-05). This store holds what that surface shows and where; OverlayMenuSurface
// draws the declaration, and the surface's page posts the choice back through the message channel.
import { create } from "zustand";
import {
  overlayMenuCardHeight,
  overlayMenuTopRows,
  OVERLAY_MENU_WIDTH,
  type OverlayMenuItem,
} from "../lib/overlayMenuPage";

/** The surface id the overlay menu declares under. One menu at a time, so one id per window. */
export const OVERLAY_MENU_LABEL = "overlay-menu";

export interface OverlayMenuBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface OverlayMenuState {
  open: boolean;
  /** Bumped every open, so a new menu is a new source the compositor rebuilds the surface for. */
  generation: number;
  items: readonly OverlayMenuItem[];
  box: OverlayMenuBox | null;
  onPick: ((id: string) => void) | null;
  /**
   * Opens the menu anchored under a rect. The box is the anchor's bottom-left, the menu's own width,
   * and the height its rows need, clamped into the viewport. onPick runs with the chosen program id.
   */
  openAt: (items: readonly OverlayMenuItem[], anchor: DOMRect, onPick: (id: string) => void) => void;
  close: () => void;
  /** Routes a surface message: the chosen id runs onPick; a dismiss just closes. */
  receive: (message: string) => void;
}

// The surface box is the menu card: placed at the anchor's bottom-left, the menu's own width, the
// height its rows need, clamped into the viewport (opened above the anchor when there is no room
// below). The webview fills this box and the page draws the bordered card in it.
const clampBox = (anchor: DOMRect, height: number): OverlayMenuBox => {
  const margin = 6;
  const width = OVERLAY_MENU_WIDTH;
  let left = anchor.left;
  let top = anchor.bottom + 2;
  if (left + width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - width);
  if (top + height > window.innerHeight - margin) {
    const above = anchor.top - 2 - height;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - height);
  }
  return { left, top, width, height };
};

export const useOverlayMenu = create<OverlayMenuState>((set, get) => ({
  open: false,
  generation: 0,
  items: [],
  box: null,
  onPick: null,
  openAt: (items, anchor, onPick) => {
    const height = overlayMenuCardHeight(overlayMenuTopRows(items));
    set((s) => ({
      open: true,
      generation: s.generation + 1,
      items,
      box: clampBox(anchor, height),
      onPick,
    }));
  },
  close: () => {
    if (!get().open) return;
    set({ open: false, items: [], box: null, onPick: null });
  },
  receive: (message) => {
    const state = get();
    if (!state.open) return;
    let parsed: { pick?: string; dismiss?: boolean };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed.pick) {
      const pick = state.onPick;
      state.close();
      pick?.(parsed.pick);
      return;
    }
    if (parsed.dismiss) state.close();
  },
}));
