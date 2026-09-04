// Workspace serialization uses the SplitPaneState wire shape for content and sidebar layouts.
//
// Snapshot field names describe the current workspace model and are converted only at this boundary.
//
// [RULE] leaf payload id (group/pane), view id and content id are preserved → the active references
// (activeContentId/activeGroupId/activeViewId/focusedPaneId/maximizedViewId) work undamaged.
// live status and live sessions (PTY/webview) are not serialized — after restore the views re-report and remount.

import { checkState } from "split-pane";
import type { CardInit, SplitPaneState } from "split-pane";
import { initialSidebarLayout, type SidebarGroup, type SidebarLayout } from "./sidebarLayout";
import { byPlace } from "./sectionSets";
import type { Workspace, Space, Pane, Tab, SidebarRegion } from "./sessions";
import { DEFAULT_RAIL_PLACEMENT,
  normalizeRailPlacement,
  type RailPlacement,
} from "../lib/railPlacement";
type GridSnapshot<T> = Omit<SplitPaneState, "cards"> & {
  cards: Array<Omit<CardInit, "data"> & { data: T }>;
};

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
  maximizedViewId?: string;
  layout: GridSnapshot<ViewGroupSnapshot>;
}

export interface WorkspaceSnapshot {
  id: string;
  title: string;
  root: string;
  color?: string;
  regionOpen: Record<SidebarRegion, boolean>;
  // Rail frame position PIN.
  railPlacement?: RailPlacement;
  // One arrangement per region. The right held a single active view and drew an icon rail of
  // everything placed there until 2026-08-16 — a region with a rule of its own (A2a).
  sidebarLayouts: Record<SidebarRegion, GridSnapshot<SidebarGroup>>;
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
  layout: {
    ...c.layout,
    cards: c.layout.cards.map((card) => ({ ...card, data: serializeViewGroup(card.data) })),
  },
});

export function serializeWorkspace(p: Workspace): WorkspaceSnapshot {
  return {
    id: p.id,
    title: p.title,
    root: p.root,
    ...(p.color ? { color: p.color } : {}),
    regionOpen: p.regionOpen,
    railPlacement: p.railPlacement ?? DEFAULT_RAIL_PLACEMENT,
    sidebarLayouts: byPlace((place) => p.sidebarLayouts[place]),
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

const deserializeGrid = <T, U>(
  state: GridSnapshot<T>,
  data: (value: T) => U,
): Omit<SplitPaneState, "cards"> & { cards: Array<Omit<CardInit, "data"> & { data: U }> } => {
  checkState(state);
  return { ...state, cards: state.cards.map((card) => ({ ...card, data: data(card.data) })) };
};

const deserializeContent = (s: ContentSnapshot): Space => {
  const layout = deserializeGrid(s.layout, deserializeViewGroup);
  return {
    id: s.id,
    title: s.title,
    activePaneId: s.activeGroupId,
    ...(s.maximizedViewId ? { maximizedTabId: s.maximizedViewId } : {}),
    layout,
  };
};

/** One region's stored arrangement, or an empty one.
 *
 *  A stored field of another shape costs that field, not the window (RESTORE R1). The workspace held
 *  one arrangement for the left and a single active view for the right until 2026-08-17; a snapshot
 *  written before that threw here, and with it went the panes, the tabs and the roots of every
 *  workspace in the window — measured, every command answered `No such workspace`. The arrangement
 *  of a region is presentation, and losing it costs the arrangement. */
function sidebarLayoutOf(stored: GridSnapshot<SidebarGroup> | undefined): SidebarLayout {
  return stored ? deserializeGrid(stored, (group) => group) : initialSidebarLayout([]);
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
    railPlacement: normalizeRailPlacement(s.railPlacement),
    sidebarLayouts: byPlace((place) => sidebarLayoutOf(s.sidebarLayouts?.[place])),
    activeSpaceId: s.activeContentId,
    spaces: s.contents.map(deserializeContent),
  };
}
