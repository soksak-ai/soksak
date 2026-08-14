// Generic header action registry (plugin socket). A plugin registers a toggle icon to the left of the
// titlebar's right control group (left/right sidebar toggles, dark mode, settings), and App's
// PluginHeaderActions renders them in order with flex. The core has no notion of what an item is for (the
// same decoupled principle as statusBarItems). One global registry, independent of panes.

import { moduleState } from "../lib/moduleState";

export interface HeaderAction {
  /** Registration id (key for unregister and update). Also used in the data-node address (titlebar/<id>). */
  id: string;
  /** Display glyph, emoji, or short text. Fallback display when icon is absent. */
  label: string;
  /** Outline icon body (optional) — SVG inner markup on a 24 viewBox (currentColor stroke).
      When set, the core renders the same single-color outline SVG as other titlebar icons and ignores label. */
  icon?: string;
  /** Tooltip (optional). */
  title?: string;
  /** Active (toggle on) — true renders emphasized. Re-register the same id to update. */
  active?: boolean;
  /** Click action. */
  onClick: () => void;
}

const actions = moduleState(
  "ui/headerActions#actions",
  () => new Map<string, HeaderAction>(),
);
const subs = moduleState(
  "ui/headerActions#subs",
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

/** Registers a header action (the same id replaces). Returns the unregister function. */
export function registerHeaderAction(action: HeaderAction): () => void {
  actions.set(action.id, action);
  notify();
  return () => {
    if (actions.delete(action.id)) notify();
  };
}

/** Registered header actions (registration order). */
export function getHeaderActions(): HeaderAction[] {
  return Array.from(actions.values());
}

/** Subscribes to registry changes (notified on add, unregister, update). Returns the unsubscribe function. */
export function subscribeHeaderActions(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
