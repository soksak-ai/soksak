// Whether the surfaces an open overlay covers have all parked and their pictures are on screen.
//
// A modal is a document overlay under the native surfaces, so its card is under a live terminal until
// that terminal parks. GroupArea tracks which panes the overlay covers and whether each covered
// surface's picture is on screen — the authority a modal needs to hold its card until every one has
// parked, so the card appears whole rather than piece by piece (measured 2026-09-05, the settings
// card revealed right-to-left as terminals parked). GroupArea writes here; a modal reads it.
import { create } from "zustand";

interface OverlayCoverReadyState {
  // True when nothing is covered, or every covered surface's picture is on screen. False while a
  // covered surface is still parking. Captures that never finish are handled by the reader's own
  // fallback, not held here.
  covered: boolean;
  allShown: boolean;
  set: (covered: boolean, allShown: boolean) => void;
}

export const useOverlayCoverReady = create<OverlayCoverReadyState>((set) => ({
  covered: false,
  allShown: true,
  set: (covered, allShown) =>
    set((s) => (s.covered === covered && s.allShown === allShown ? s : { ...s, covered, allShown })),
}));
