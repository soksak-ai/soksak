// Generic status bar item registry (plugin socket). A plugin registers a status bar item
// (label, optional click handler) bound to a view, and the status bar of the group showing that
// view renders it. The core interprets nothing — it places what it is given and reads no meaning
// into any of it.
//
// Everything in the bar arrives this way. Until 2026-08-16 the core drew two of them itself: a
// Status items are registered by their owners; the frame does not branch on content kinds.

import { moduleState } from "../lib/moduleState";

export interface StatusBarItem {
  /** Registration id (unregister/update key). Usually "<plugin>:<viewId>". */
  id: string;
  /** View this item is shown on. */
  paneId: string;
  /** Display text. */
  label: string;
  /** Tooltip (optional). */
  title?: string;
  /** Active (toggle on) state — true renders in the accent color. Update by re-registering with the same id. */
  active?: boolean;
  /** Which end of the bar. Position only — the core reads no meaning into the side. Default "right". */
  side?: "left" | "right";
  /** Click action. Omitted = the item is a reading, not a control. */
  onClick?: () => void;
}

const items = moduleState(
  "ui/statusBarItems#items",
  () => new Map<string, StatusBarItem>(),
);
const subs = moduleState(
  "ui/statusBarItems#subs",
  () => new Set<() => void>(),
);
const notify = () => {
  for (const cb of [...subs]) {
    try {
      cb();
    } catch {
      // Isolate subscriber failure — never propagate it to another subscriber or the host.
    }
  }
};

/** Register a status bar item (same id replaces). Returns the unregister function. */
export function registerStatusBarItem(item: StatusBarItem): () => void {
  items.set(item.id, item);
  notify();
  return () => {
    if (items.delete(item.id)) notify();
  };
}

/** Items bound to a given pane, in registration order. */
export function statusBarItemsForTab(paneId: string): StatusBarItem[] {
  const out: StatusBarItem[] = [];
  for (const it of items.values()) if (it.paneId === paneId) out.push(it);
  return out;
}

/** Subscribe to registry changes (notified on add/remove). Returns the unsubscribe function. */
export function subscribeStatusBarItems(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
