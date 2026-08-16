// Workspace serialization — layout to a plain JSON snapshot (persist and restore, A2). Both trees (PaneNode,
// SidebarLayout) serialize through the same serializeSplitTree path in splitTree.ts (no duplication).
//
// [RULE] Wire keys stay on the old shape (contents·views·activeViewId·activeGroupId·activeContentId·
// maximizedViewId·railBindingViewId) — the migration (P0-5) moves them. In-memory fields are already the new
// vocabulary (spaces·tabs·activeTabId·activePaneId·activeSpaceId·maximizedTabId·railBindingTabId), so the two
// are joined only inside this file's serialize/deserialize. Existing user snapshots still open unchanged.
//
// [RULE] leaf payload id (group/pane), view id and content id are preserved → the active references
// (activeContentId/activeGroupId/activeViewId/focusedPaneId/maximizedViewId) work undamaged.
// Only split id is regenerated on restore (used for tree structure alone and never referenced, so
// serializeSplitTree omits it).
// live status and live sessions (PTY/webview) are not serialized — after restore the views re-report and remount.

import {
  serializeSplitTree,
  deserializeSplitTree,
  type SplitSnapshot,
} from "./splitTree";
import { initialSidebarLayout, type SidebarGroup, type SidebarLayout } from "./sidebarLayout";
import type { Workspace, Space, Pane, Tab, SidebarRegion } from "./sessions";
import { DEFAULT_RAIL_PLACEMENT,
  normalizeRailPlacement,
  type RailPlacement,
} from "../lib/railPlacement";
import { normalizeVerticalLines } from "./verticalLines";

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

interface ContentSnapshot {
  id: string;
  title: string;
  activeGroupId: string;
  railBindingViewId?: string;
  maximizedViewId?: string;
  layout: SplitSnapshot<ViewGroupSnapshot>;
}

export interface WorkspaceSnapshot {
  id: string;
  title: string;
  root: string;
  color?: string;
  // Vertical-line normalization migration marker — serialization always writes it. Only an old snapshot without
  // the marker is healed once on restore by normalizeVerticalLines; a restore with the marker is identity —
  // restore never rewrites a separate line the user placed outside the drag rule (LINE_GROUP_EPS).
  vlNormalized?: true;
  // One-time placement migration marker — while rail migration was withdrawn, serialization wrote an anchor
  // (pin@0) even for workspaces with no placement set. The placement in a snapshot without the marker may be that
  // era's default, so it is dropped once (removal condition: no marker-less snapshot left in the field).
  railPlacementNormalized?: true;
  sidebarOpen: boolean;
  // Rail frame position PIN.
  leftRailPlacement?: RailPlacement;
  rightOpen: boolean;
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
  ...(c.railBindingTabId ? { railBindingViewId: c.railBindingTabId } : {}),
  ...(c.maximizedTabId ? { maximizedViewId: c.maximizedTabId } : {}),
  layout: serializeSplitTree(c.layout, serializeViewGroup), // PaneNode(leaf=Pane)
});

export function serializeWorkspace(p: Workspace): WorkspaceSnapshot {
  return {
    id: p.id,
    title: p.title,
    root: p.root,
    ...(p.color ? { color: p.color } : {}),
    vlNormalized: true,
    railPlacementNormalized: true,
    sidebarOpen: p.sidebarOpen,
    leftRailPlacement: p.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT,
    rightOpen: p.rightOpen,
    // Sidebar layout (SplitTree<SidebarGroup>) — the leaf payload is plain JSON.
    sidebarLayouts: {
      left: serializeSplitTree(p.sidebarLayouts.left, (g) => g),
      right: serializeSplitTree(p.sidebarLayouts.right, (g) => g),
    },
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

const deserializeContent = (s: ContentSnapshot, normalize: boolean): Space => {
  const layout = deserializeSplitTree(s.layout, deserializeViewGroup);
  return {
    id: s.id,
    title: s.title,
    activePaneId: s.activeGroupId,
    ...(s.railBindingViewId ? { railBindingTabId: s.railBindingViewId } : {}),
    ...(s.maximizedViewId ? { maximizedTabId: s.maximizedViewId } : {}),
    // One migration per snapshot (the vertical no-split proposition) — only an old snapshot without the
    // vlNormalized marker is healed by snapping vertical lines fragmented before companion drag (e.g. top 40.6 /
    // bottom 39.5) to the x of the topmost segment. A restore with the marker is identity — it does not rewrite
    // the user's layout.
    // [removal condition] Drop the gate once marker-less snapshots are gone from the field (re-saved with the marker).
    layout: normalize ? normalizeVerticalLines(layout) : layout,
  };
};

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
    sidebarOpen: s.sidebarOpen,
    // The stored value of an old snapshot without the marker is not trusted — there is no way to separate the
    // withdrawn era's default (pin@0) from an anchor the user chose, so it is reset once to the default (flow).
    // With the marker present the stored value is honored.
    leftRailPlacement: s.railPlacementNormalized
      ? normalizeRailPlacement(s.leftRailPlacement)
      : DEFAULT_RAIL_PLACEMENT,
    rightOpen: s.rightOpen,
    sidebarLayouts: {
      left: sidebarLayoutOf(s.sidebarLayouts?.left),
      right: sidebarLayoutOf(s.sidebarLayouts?.right),
    },
    activeSpaceId: s.activeContentId,
    spaces: s.contents.map((c) => deserializeContent(c, !s.vlNormalized)),
  };
}
