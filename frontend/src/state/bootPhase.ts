// Boot phase state surface — the single fact that separates "an empty slot" from "a slot about to be
// filled" (user decision 2026-07-27: knowing whether something will appear or the slot is just empty
// prevents a mistaken read).
//
// In a boot where restore comes before the plugin host (restore 300ms baseline), the screen appears at
// once and view bodies fill in afterwards — drawing an unregistered view as "no view" in that gap is a lie.
// Boot drives the phase (restoring → activating → ready); consumers only read it:
//   · PluginViewHost — unregistered before ready = loading, unregistered after ready = genuine absence.
//   · BootPhaseBadge — a faint progress mark in the window corner before ready.
// Initial value is ready — entry points outside the boot contract (tests, orchestrator) stay as they are, with no phase.
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";

export type BootPhase = "restoring" | "activating" | "ready";

interface BootPhaseState {
  phase: BootPhase;
  setPhase: (phase: BootPhase) => void;
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the side that filled them treats them as already
// filled and never refills (empty forever).
export const useBootPhase = moduleState("state/bootPhase#store", () =>
  create<BootPhaseState>((set) => ({
  phase: "ready",
  setPhase: (phase) => set({ phase }),
})),
);
