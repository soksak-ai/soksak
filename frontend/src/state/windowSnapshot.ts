// Workspace serialization — layout to a plain JSON snapshot (persist and restore, A2). A space's
// plane is stored as the library's own state (`toJSON`); the sidebar tree serializes through
// splitTree.ts.
//
// [RULE] Wire keys stay on the old shape (contents·views·activeViewId·activeGroupId·activeContentId·
// maximizedViewId). In-memory fields are the new vocabulary (spaces·tabs·activeTabId·activePaneId·
// activeSpaceId·maximizedTabId), so the two are joined only inside this file's serialize/deserialize.
//
// [RULE] Every id is preserved → the active references (activeContentId/activeGroupId/activeViewId/
// maximizedViewId) work undamaged. A record of another shape is refused by name
// (windowSnapshotShape.ts), never mended.
// live status and live sessions (PTY/webview) are not serialized — after restore the views re-report and remount.

import {
  serializeSplitTree,
  deserializeSplitTree,
  type SplitSnapshot,
} from "./splitTree";
import { initialSidebarLayout, type SidebarGroup, type SidebarLayout } from "./sidebarLayout";
import { byPlace } from "./sectionSets";
import type { Workspace, Space, Pane, Tab, SidebarRegion } from "./sessions";
import { DEFAULT_RAIL_PLACEMENT, isRailPlacement, type RailPlacement } from "../lib/railPlacement";
import type { PlaneState } from "./panePlane";

// ── Snapshot types ───────────────────────────────────────────────────────────

type ViewSnapshot =
  | {
      id: string;
      kind: "plugin";
      title: string;
      // User-set tab label (view.rename) — persisted because it is user intent. Optional (old-snapshot compatible).
      customLabel?: string;
      pluginId: string;
      view: string;
      // Tab icon (a content fact — the favicon URL). Optional (old-snapshot compatible).
      icon?: string;
      // B3 — observed cwd (restore spawn location) and last activity time (hydration priority). Optional (old-snapshot compatible).
      cwd?: string;
      lastActivity?: number;
      legacyPaneId?: string;
      // B3 — plugin-observed state (setRestoreState — e.g. browser URL). Becomes restore.state on the restore mount.
      state?: unknown;
    };

interface ViewGroupSnapshot {
  id: string;
  activeViewId: string;
  views: ViewSnapshot[];
}

export interface ContentSnapshot {
  id: string;
  title: string;
  activeGroupId: string;
  maximizedViewId?: string;
  /** What each pane holds, by id. */
  groups: ViewGroupSnapshot[];
  /** Where each pane is, and the rail when it stands: the plane's own state. */
  plane: PlaneState;
}

export interface WorkspaceSnapshot {
  id: string;
  title: string;
  root: string;
  color?: string;
  regionOpen: Record<SidebarRegion, boolean>;
  // How the rail behaves when focus moves. Where it stands is in each space's plane.
  railPlacement: RailPlacement;
  // One arrangement per region. The right held a single active view and drew an icon rail of
  // everything placed there until 2026-08-16 — a region with a rule of its own (A2a).
  sidebarLayouts: Record<SidebarRegion, SplitSnapshot<SidebarGroup>>;
  activeContentId: string;
  contents: ContentSnapshot[];
  // Rail pins (§4.5) — persisted with the workspace.
}

// ── serialize ─────────────────────────────────────────────────────────────────

function serializeView(v: Tab): ViewSnapshot {
  switch (v.kind) {
    case "plugin":
      // command (autorun) is not persisted — a restored terminal does not re-run the command (A6: a live PTY
      // cannot be restored and re-running has side effects). Autorun happens only on a fresh open.
      return {
        id: v.id,
        kind: "plugin",
        title: v.title,
        ...(v.customLabel ? { customLabel: v.customLabel } : {}),
        ...(v.icon ? { icon: v.icon } : {}),
        pluginId: v.pluginId,
        view: v.view,
        // B3 — last cwd, activity time and plugin state are the substance of a restore.
        ...(v.cwd ? { cwd: v.cwd } : {}),
        ...(v.lastActivity ? { lastActivity: v.lastActivity } : {}),
        ...(v.legacyPaneId ? { legacyPaneId: v.legacyPaneId } : {}),
        ...(v.state !== undefined ? { state: v.state } : {}),
      };
  }
}

const serializeViewGroup = (g: Pane): ViewGroupSnapshot => ({
  id: g.id,
  activeViewId: g.activeTabId,
  views: g.tabs.map(serializeView),
});

const serializeContent = (c: Space): ContentSnapshot => ({
  id: c.id,
  title: c.title,
  activeGroupId: c.activePaneId,
  ...(c.maximizedTabId ? { maximizedViewId: c.maximizedTabId } : {}),
  groups: c.panes.map(serializeViewGroup),
  plane: c.layout,
});

export function serializeWorkspace(p: Workspace): WorkspaceSnapshot {
  return {
    id: p.id,
    title: p.title,
    root: p.root,
    ...(p.color ? { color: p.color } : {}),
    regionOpen: p.regionOpen,
    railPlacement: p.railPlacement ?? DEFAULT_RAIL_PLACEMENT,
    // Sidebar layout (SplitTree<SidebarGroup>) — the leaf payload is plain JSON.
    sidebarLayouts: byPlace((place) => serializeSplitTree(p.sidebarLayouts[place], (g) => g)),
    activeContentId: p.activeSpaceId,
    contents: p.spaces.map(serializeContent),
  };
}

// ── deserialize (only split id regenerated; other ids and active references kept) ──

function deserializeView(s: ViewSnapshot): Tab {
  switch (s.kind) {
    case "plugin":
      // command is not restored — a restored terminal does not re-run the command (A6).
      return {
        id: s.id,
        kind: "plugin",
        title: s.title,
        ...(s.customLabel ? { customLabel: s.customLabel } : {}),
        ...(s.icon ? { icon: s.icon } : {}),
        pluginId: s.pluginId,
        view: s.view,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.lastActivity ? { lastActivity: s.lastActivity } : {}),
        ...(s.legacyPaneId ? { legacyPaneId: s.legacyPaneId } : {}),
        ...(s.state !== undefined ? { state: s.state } : {}),
      };
  }
}

const deserializeViewGroup = (s: ViewGroupSnapshot): Pane => ({
  id: s.id,
  activeTabId: s.activeViewId,
  tabs: s.views.map(deserializeView),
});

const deserializeContent = (s: ContentSnapshot): Space => ({
  id: s.id,
  title: s.title,
  activePaneId: s.activeGroupId,
  ...(s.maximizedViewId ? { maximizedTabId: s.maximizedViewId } : {}),
  panes: s.groups.map(deserializeViewGroup),
  layout: s.plane,
});

/** One region's stored arrangement, or an empty one.
 *
 *  A stored field of another shape costs that field, not the window (RESTORE R1). The workspace held
 *  one arrangement for the left and a single active view for the right until 2026-08-17; a snapshot
 *  written before that threw here, and with it went the panes, the tabs and the roots of every
 *  workspace in the window — measured, every command answered `No such workspace`. The arrangement
 *  of a region is presentation, and losing it costs the arrangement. */
function sidebarLayoutOf(stored: SplitSnapshot<SidebarGroup> | undefined): SidebarLayout {
  if (!stored) return initialSidebarLayout([]);
  try {
    return deserializeSplitTree(stored, (g) => g);
  } catch {
    return initialSidebarLayout([]);
  }
}

export function deserializeWorkspace(s: WorkspaceSnapshot): Workspace {
  return {
    id: s.id,
    title: s.title,
    root: s.root,
    ...(s.color ? { color: s.color } : {}),
    // The rail is open on a workspace that never said, the two edges are not. A snapshot from
    // before the left edge existed has nothing for it, and nothing is what it gets.
    regionOpen: byPlace((place) => s.regionOpen?.[place] ?? place === "rail"),
    // A placement of another shape — a pinned station from before 2026-09-05, or none — is
    // presentation, and costs that field only (RESTORE R1): the rail follows focus.
    railPlacement: isRailPlacement(s.railPlacement) ? s.railPlacement : DEFAULT_RAIL_PLACEMENT,
    sidebarLayouts: byPlace((place) => sidebarLayoutOf(s.sidebarLayouts?.[place])),
    activeSpaceId: s.activeContentId,
    spaces: s.contents.map(deserializeContent),
  };
}
