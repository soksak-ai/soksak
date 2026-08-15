// Pick the pane under this position and activate it — **one function for every entry path.**
//
// There are two entry paths: the contract event that a content view took focus, and a coordinate on the
// surface (the native mouse monitor of a framework whose content is outside the document). A separate
// decision per path means only one of them gets fixed and the mismatch raises no error — a click on the
// browser that leaves the binding unchanged is that silent shape (measured 2026-08-02).
import { allGroups, useSessions } from "../state/sessions";
import { activeSessionViewId, transferViewFocus } from "../plugins/viewFocus";

export function bindPaneUnder(el: Element | null): void {
  const slot = el?.closest<HTMLElement>("[data-pane]");
  // Name and value point at the same thing — the attribute is `data-pane` (pane id). `dataset.groupId`
  // looks up `data-group-id`, which does not exist, so it is always undefined and everything below this
  // line never runs (measured 2026-08-02: the pane was found but no binding happened).
  const groupId = slot?.dataset.pane;
  const projectId = slot?.dataset.projectId;
  if (!groupId || !projectId) return;
  const state = useSessions.getState();
  const workspace = state.workspaces.find((item) => item.id === projectId);
  const space = workspace?.spaces.find((item) => item.id === workspace.activeSpaceId);
  const group = space ? allGroups(space.layout).find((item) => item.id === groupId) : null;
  const targetViewId = group?.activeTabId;
  if (targetViewId) {
    transferViewFocus(activeSessionViewId(), targetViewId, () =>
      state.setActiveGroup(projectId, groupId),
    );
  } else {
    state.setActiveGroup(projectId, groupId);
  }
}
