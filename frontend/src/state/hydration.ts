// Restore hydration gate (B4) — visuals atomic, resources deferred.
// Restart restore draws every tab and layout at once (atomic appearance), while heavy view bodies
// (terminal PTY spawn, plugin mount) are mounted immediately (hot) only for views visible on
// screen and the rest (cold) are mounted at promotion. Promotion = (1) the moment that view
// becomes visible (tab switch, activation), (2) after boot settles, an idle chain takes one at a
// time in descending lastActivity order (not polling — requestIdleCallback recursion, ends when
// the queue empties). The process is not exposed: the slots are parked/inactive, so the filling
// is not visible, and on open the view is already (or immediately) filled.

import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import { useSessions, allGroups } from "./sessions";

interface HydrationStore {
  // Set of view ids whose body mount is still deferred. Empty means the gate passes everything (cost 0 in the normal case).
  cold: Set<string>;
  markCold: (viewIds: string[]) => void;
  promote: (viewId: string) => void;
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the side that filled them treats them as already
// filled and never refills (empty forever).
export const useHydration = moduleState("state/hydration#store", () =>
  create<HydrationStore>((set, get) => ({
  cold: new Set(),
  markCold: (viewIds) => {
    if (viewIds.length === 0) return;
    set({ cold: new Set([...get().cold, ...viewIds]) });
  },
  promote: (viewId) => {
    const cur = get().cold;
    if (!cur.has(viewId)) return;
    const next = new Set(cur);
    next.delete(viewId);
    set({ cold: next });
  },
})),
);

/** Once right after restore — marks restored views not visible on screen as cold and starts the idle promotion chain.
 *  Visible view = each group's activeViewId in the active content of the active project (several when split). */
export function beginRestoreHydration(): void {
  const s = useSessions.getState();
  const cold: string[] = [];
  const activity = new Map<string, number>();
  for (const t of s.projects) {
    for (const c of t.spaces) {
      const contentVisible = t.id === s.activeId && c.id === t.activeSpaceId;
      for (const g of allGroups(c.layout)) {
        for (const v of g.tabs) {
          if (v.kind !== "plugin") continue; // File views are cheap — outside the gate
          const visible = contentVisible && g.activeTabId === v.id;
          if (!visible) {
            cold.push(v.id);
            activity.set(v.id, v.lastActivity ?? 0);
          }
        }
      }
    }
  }
  if (cold.length === 0) return;
  useHydration.getState().markCold(cold);

  // Idle promotion chain — one per tick in recent-activity order (spreads the CPU spike right after boot).
  const queue = [...cold].sort((a, b) => (activity.get(b) ?? 0) - (activity.get(a) ?? 0));
  const ric: (cb: () => void) => void =
    typeof requestIdleCallback === "function"
      ? (cb) => requestIdleCallback(() => cb(), { timeout: 2000 })
      : (cb) => setTimeout(cb, 250); // Fallback (tests and the like) — the chain runs once, so this is not polling
  const step = () => {
    const { cold: cur, promote } = useHydration.getState();
    // Skip items already promoted (tab switch).
    let next: string | undefined;
    while ((next = queue.shift()) !== undefined) {
      if (cur.has(next)) break;
    }
    if (next === undefined) return; // Queue drained — the chain ends
    promote(next);
    if (queue.length > 0) ric(step);
  };
  ric(step);
}
