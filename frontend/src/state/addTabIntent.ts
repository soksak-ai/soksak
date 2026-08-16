// A request to open the add-tab menu on a pane, from wherever the request came from.
//
// The keyboard shortcut fires at the window and the menu is drawn by the tab bar, so one of them
// has to signal the other. This is that channel: a pane id and nothing else.
//
// Until 2026-08-16 the shortcut opened a terminal: it resolved a contract id the core spelled out,
// `soksak-spec-plugin-terminal`, and a plugin's own spec is not the core's to name (PLUGIN-CONTRACT
// P5). "A new tab" is the frame's, which the core owns; "a new terminal" is a view about content.
// The menu is the program registry's projection, so the person picks and the core names nothing.
import { create } from "zustand";
import { moduleState } from "../lib/moduleState";

interface AddTabIntentState {
  /** The pane whose add menu should open, and the request's own number so two requests for the
   *  same pane are two requests. null = nothing pending. */
  request: { paneId: string; seq: number } | null;
  open: (paneId: string) => void;
  clear: () => void;
}

// Outside the hot-swap boundary — a replaced store would leave the tab bar subscribed to the old
// one, and the shortcut would then do nothing with nothing reporting it.
export const useAddTabIntent = moduleState("state/addTabIntent#store", () =>
  create<AddTabIntentState>((set, get) => ({
    request: null,
    open: (paneId) => set({ request: { paneId, seq: (get().request?.seq ?? 0) + 1 } }),
    clear: () => set({ request: null }),
  })),
);
