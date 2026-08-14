// Generic status bar item registry (plugin socket). A plugin registers a status bar item
// (label + click handler) bound to a paneId, and the status bar of the group whose active
// terminal is that pane (GroupStatusBar) renders it. The core does not interpret an item's
// purpose — domains such as claude-GUI are entirely plugin-owned (same decoupled principle
// as command.started and data-pane-id).

import { moduleState } from "../lib/moduleState";

export interface StatusBarItem {
  /** Registration id (unregister/update key). Usually "<plugin>:<paneId>". */
  id: string;
  /** Terminal pane this item is shown on. */
  paneId: string;
  /** Display text. */
  label: string;
  /** Tooltip (optional). */
  title?: string;
  /** Active (toggle on) state — true renders in the accent color. Update by re-registering with the same id. */
  active?: boolean;
  /** Click action. */
  onClick: () => void;
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
      // Subscriber failure isolation — never propagated to another subscriber or to the host.
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
