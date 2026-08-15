// In-app notification banner store — banner display while the app is focused (OS notifications when unfocused).
// One store per window (multi-window) — the banner appears only in the window that called push (single click
// handling). Keeps the most recent N only.

import { moduleState } from "../lib/moduleState";
import { create } from "zustand";

export interface NotifyAction {
  label: string;
  deepLink: string; // soksak://cmd/...
}

export interface NotifyBanner {
  id: string;
  title: string;
  body?: string;
  icon?: string; // Glyph or emoji
  image?: string; // URL or asset path (thumbnail)
  deepLink?: string; // Command URI to activate on a click in the body
  actions?: NotifyAction[];
}

const MAX_VISIBLE = 4;

interface NotifyState {
  banners: NotifyBanner[];
  show: (b: NotifyBanner) => void;
  dismiss: (id: string) => void;
}

// The store is outside the module boundary — if a hot swap replaces it, registrations, subscriptions, and screen
// state all become new, while the filling side treats them as already filled and never refills (empty forever).
export const useNotify = moduleState("state/notify#store", () =>
  create<NotifyState>((set) => ({
  banners: [],
  // Same id replaces the old one (dedupe); keep only the most recent MAX_VISIBLE.
  show: (b) =>
    set((s) => ({
      banners: [...s.banners.filter((x) => x.id !== b.id), b].slice(-MAX_VISIBLE),
    })),
  dismiss: (id) => set((s) => ({ banners: s.banners.filter((x) => x.id !== id) })),
})),
);
