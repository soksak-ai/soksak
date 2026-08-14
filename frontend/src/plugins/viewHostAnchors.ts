// DOM anchor contract of the plugin view host — exposes core-issued identifiers for lookup from the DOM.
//
// [PRINCIPLE] Symmetry: a stable identifier the core issues to a plugin (paneId) must be
//   dereferenceable from the DOM. If statusBarItem can attach by paneId, a pane overlay must be
//   able to attach by paneId too.
//
// data-view-addr: baseAddress (absolute address) for nodeScan. All placements (content/left/right).
// data-tab-id:    lookup anchor for the tab instance id. Content placement (with tabs) only.
//   The ui:overlay plugin finds this host by the id that command.started and statusBarItem issued.
//   A sidebar host's target is the terminal it tracks, not its own instance id, so it stamps no anchor.
// (2026-07-27) The old name data-pane-id was removed — the removal conditions (every consuming
//   plugin migrated to data-tab-id, 0 repo selector greps) were met (last consumer claude-gui
//   migrated in 6b0e7ef). One name per value.
//
// [history] In 942ae86 (built-in terminal → plugin) the anchor the core terminal view stamped did
//   not move to the unified host (PluginViewHost) and went missing → claude-gui, which finds the
//   host by that id, regressed. This function restores that anchor as the single truth, and
//   viewHostAnchors.test.ts blocks a recurrence.
export function viewHostAnchors(
  viewAddr: string,
  viewId: string | null,
): Record<string, string> {
  const anchors: Record<string, string> = { "data-view-addr": viewAddr };
  if (viewId) {
    anchors["data-tab-id"] = viewId;
  }
  return anchors;
}
