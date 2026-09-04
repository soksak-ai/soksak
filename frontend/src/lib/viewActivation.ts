import { execute } from "../commands/registry";
import { activeSessionViewId, transferViewFocus } from "../plugins/viewFocus";
import { allGroups, useSessions } from "../state/sessions";

export function activateTabIntent(tabId: string): boolean {
  if (!tabId || activeSessionViewId() === tabId) return false;
  transferViewFocus(activeSessionViewId(), tabId, () =>
    void execute("tab.activate", { tab: tabId }, {}),
  );
  return true;
}

export function activatePaneIntent(paneId: string): boolean {
  const sessions = useSessions.getState();
  const workspace = sessions.workspaces.find((item) => item.id === sessions.activeId);
  const space = workspace?.spaces.find((item) => item.id === workspace.activeSpaceId);
  const pane = space ? allGroups(space).find((item) => item.id === paneId) : null;
  if (!pane) return false;
  const target = pane.activeTabId;
  // Re-clicking the active pane is a focus repair, not an idempotent no-op. The view may have
  // lost DOM focus while the session state stayed unchanged; route the same target through the
  // coordinator so the provider restores its input owner without writing session state.
  if (space?.activePaneId === paneId && activeSessionViewId() === target) {
    if (target) transferViewFocus(target, target, () => undefined);
    return true;
  }
  if (target) {
    transferViewFocus(activeSessionViewId(), target, () =>
      void execute("pane.activate", { pane: paneId }, {}),
    );
  } else {
    void execute("pane.activate", { pane: paneId }, {});
  }
  return true;
}

export function activateExposedInputTarget(target: Element | null): boolean {
  const tab = target?.closest<HTMLElement>("[data-input-activate-tab]");
  if (tab?.dataset.inputActivateTab) return activateTabIntent(tab.dataset.inputActivateTab);
  const pane = target?.closest<HTMLElement>("[data-input-activate-pane]");
  if (pane?.dataset.inputActivatePane) return activatePaneIntent(pane.dataset.inputActivatePane);
  return false;
}
