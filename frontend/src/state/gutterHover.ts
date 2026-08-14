// Gutter under the mouse (the resize boundary between panes). A native child (browser and such) is an
// OS view, so DOM :hover does not fire over it — the core native-mouse bridge (App.tsx) sets the gutter
// at the hover coordinate here, and GroupArea subscribes to highlight it and briefly pull the two
// adjacent cells back (seam) to expose the gutter from under the native view. Single truth for showing
// the boundary "only on hover", including the flat theme (pane-inset 0). null when there is no key.
//
// Only the file name and the name useGutterHover remain from the old vocabulary. The command layer
// (catalogDom) consumes this symbol, so a rename touches two lanes at once — the command surface lane
// moves it together with that one import line. The file becomes gutterHover.ts then. The value stored
// here is already the canonical gutter address (see the key comment below).
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";

interface GutterHoverState {
  key: string | null; // Canonical gutter address `gutter/<pan-id>/<right|bottom>`. null when absent.
  set: (key: string | null) => void;
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the side that filled them treats them as already
// filled and never refills (empty forever).
export const useGutterHover = moduleState("state/gutterHover#store", () =>
  create<GutterHoverState>((set) => ({
  key: null,
  // Same value keeps the state object unchanged — avoids a needless re-render on every hover move (mostly not a gutter = null).
  set: (key) => set((s) => (s.key === key ? s : { key })),
})),
);
