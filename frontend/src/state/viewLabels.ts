// viewLabels — user-set tab label per viewKey ("<pluginId>.<viewId>"), persisted by core.
//
// [RULE] The tab label override for sidebar views (left and right) is a generic channel owned by
// core — not a special case for one plugin (folderpop and such) but shared by every sidebar view (no
// core lock-in). Unset falls back to the manifest title (view.decl.title) — the manifest is the
// default single source of truth, and the override holds user intent only.
//
// Persistence: app.data core ns "viewLabels" (multi-window consistency). boot (windowBoot) hydrates
// and subscribes. Synchronous boot uses the localStorage cache (coreStore) — same pattern as the
// other persisted state.

import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import { makeCoreStore, type CoreStoreDeps } from "./coreStore";

type LabelMap = Record<string, string>;

interface ViewLabelsState {
  labels: LabelMap;
  setLabel: (viewKey: string, label: string) => void;
  clearLabel: (viewKey: string) => void;
  // Wholesale replacement from outside (coreStore hydrate/broadcast) — distinct from the user input
  // path (set/clear).
  replaceAll: (labels: LabelMap) => void;
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the side that filled them treats them as already
// filled and never refills (empty forever).
export const useViewLabels = moduleState("state/viewLabels#store", () =>
  create<ViewLabelsState>((set, get) => ({
  labels: {},
  setLabel: (viewKey, label) => {
    const trimmed = label.trim();
    const labels = { ...get().labels };
    if (trimmed) labels[viewKey] = trimmed;
    else delete labels[viewKey]; // empty or whitespace = drop the override and fall back to the manifest
    set({ labels });
    ms.persist?.(labels);
  },
  clearLabel: (viewKey) => {
    const labels = { ...get().labels };
    delete labels[viewKey];
    set({ labels });
    ms.persist?.(labels);
  },
  replaceAll: (labels) => set({ labels }),
})),
);

// Display label for a viewKey — override first, otherwise fallback (manifest title).
export function resolveViewLabel(viewKey: string, fallback: string): string {
  return useViewLabels.getState().labels[viewKey] ?? fallback;
}

// ── Persistence wiring (once at boot) ──────────────────────────────────────────
// coreStore uses async invoke, so it cannot be injected at module load — boot inits it with deps.

// Outside the hot-swap boundary — if these values are replaced, the "already done" record, the lazy init
// and the unsubscribe slot disappear together, and the filling side does not fill again.
const ms = moduleState("state/viewLabels#state", () => ({
  persist: null as ((labels: LabelMap) => void) | null,
}));

export function initViewLabelsPersistence(deps: CoreStoreDeps): () => void {
  const store = makeCoreStore<LabelMap>({
    key: "viewLabels",
    lsKey: "soksak.viewLabels",
    fallback: {},
    ...deps,
  });
  // Fill immediately from the sync cache (before render), then hydrate with the authoritative value.
  useViewLabels.getState().replaceAll(store.loadSync());
  void store.hydrate().then((v) => useViewLabels.getState().replaceAll(v));
  // Apply changes from other windows.
  const un = store.subscribe((v) => useViewLabels.getState().replaceAll(v));
  // User input (set/clear) → save.
  ms.persist = (labels) => void store.save(labels);
  return () => {
    un();
    ms.persist = null;
  };
}
