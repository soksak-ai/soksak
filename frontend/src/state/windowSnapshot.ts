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
import type { SidebarGroup } from "./sidebarLayout";
import type { Workspace, Space, Pane, Tab } from "./sessions";
import type { Pins } from "./projection";
import { DEFAULT_RAIL_PLACEMENT,
  normalizeRailPlacement,
  type RailPlacement,
} from "../lib/railPlacement";
import { normalizeVerticalLines } from "./verticalLines";
import { issueId, type IssuedKind } from "./ids";

// ── Snapshot types ───────────────────────────────────────────────────────────

type ViewSnapshot =
  | {
      id: string;
      kind: "file";
      title: string;
      customLabel?: string;
      path: string;
      mode: "code" | "preview";
    }
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
  shell?: string;
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
  // Rail frame position PIN. Orthogonal to projection.pins (ref pinning). Optional for old-snapshot compatibility.
  leftRailPlacement?: RailPlacement;
  rightOpen: boolean;
  rightView: string | null;
  leftLayout: SplitSnapshot<SidebarGroup>;
  activeContentId: string;
  contents: ContentSnapshot[];
  // Rail pins (§4.5) — persisted with the workspace.
  projection?: { pins: Pins };
}

// ── serialize ─────────────────────────────────────────────────────────────────

function serializeView(v: Tab): ViewSnapshot {
  switch (v.kind) {
    case "file":
      return {
        id: v.id,
        kind: "file",
        title: v.title,
        ...(v.customLabel ? { customLabel: v.customLabel } : {}),
        path: v.path,
        mode: v.mode,
      };
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

export function serializeWorkspace(
  p: Workspace,
  projection?: { pins: Pins },
): WorkspaceSnapshot {
  return {
    ...(projection ? { projection } : {}),
    id: p.id,
    title: p.title,
    root: p.root,
    ...(p.shell ? { shell: p.shell } : {}),
    ...(p.color ? { color: p.color } : {}),
    vlNormalized: true,
    railPlacementNormalized: true,
    sidebarOpen: p.sidebarOpen,
    leftRailPlacement: p.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT,
    rightOpen: p.rightOpen,
    rightView: p.rightView,
    // Sidebar layout (SplitTree<SidebarGroup>) — the leaf payload is plain JSON.
    leftLayout: serializeSplitTree(p.leftLayout, (g) => g),
    activeContentId: p.activeSpaceId,
    contents: p.spaces.map(serializeContent),
  };
}

// ── deserialize (only split id regenerated; other ids and active references kept) ──

function deserializeView(s: ViewSnapshot, _newSplitId: () => string): Tab {
  switch (s.kind) {
    case "file":
      return {
        id: s.id,
        kind: "file",
        title: s.title,
        ...(s.customLabel ? { customLabel: s.customLabel } : {}),
        path: s.path,
        mode: s.mode,
      };
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

/**
 * The identifiers one restored workspace takes, and the table that keeps its references pointing
 * at them.
 *
 * RESTORE R3 — ids are minted again, and that is the contract. `state.fingerprint`, the one number
 * a restore is judged by, holds no id: a workspace is identified across a restart by its root
 * (V1), and a window name is issued fresh at every open.
 *
 * Only split ids were minted until 2026-08-16. Everything else was carried across verbatim, so
 * `t1` — a counter with no prefix, from before the issuer existed — was the workspace id of three
 * separate window snapshots at once, months after nothing could mint it. A store is where a
 * retired shape outlives the code that made it, and this was the way in.
 *
 * A reference to something that was never minted is left as it was rather than blanked. An empty
 * string is a legitimate "nothing is active", and turning an unknown reference into one would hide
 * a snapshot this build did not understand instead of leaving it visible.
 */
interface RestoreIds {
  take(kind: IssuedKind, stored: string): string;
  follow(stored: string): string;
}

function restoreIds(): RestoreIds {
  const minted = new Map<string, string>();
  return {
    take(kind, stored) {
      const fresh = issueId(kind);
      if (stored) minted.set(stored, fresh);
      return fresh;
    },
    follow(stored) {
      return minted.get(stored) ?? stored;
    },
  };
}

const deserializeViewGroup = (
  s: ViewGroupSnapshot,
  newSplitId: () => string,
  mint: RestoreIds,
): Pane => {
  // The tabs first, so the reference below names an id that has been minted.
  const tabs = s.views.map((v) => ({ ...deserializeView(v, newSplitId), id: mint.take("tab", v.id) }));
  return {
    id: mint.take("pane", s.id),
    activeTabId: mint.follow(s.activeViewId),
    tabs,
  };
};

const deserializeContent = (
  s: ContentSnapshot,
  newSplitId: () => string,
  normalize: boolean,
  mint: RestoreIds,
): Space => {
  // The tree first, for the same reason: every reference below is read after the id it names has
  // been minted.
  const layout = deserializeSplitTree(
    s.layout,
    (g) => deserializeViewGroup(g, newSplitId, mint),
    newSplitId,
  );
  return {
    id: mint.take("space", s.id),
    title: s.title,
    activePaneId: mint.follow(s.activeGroupId),
    ...(s.railBindingViewId ? { railBindingTabId: mint.follow(s.railBindingViewId) } : {}),
    ...(s.maximizedViewId ? { maximizedTabId: mint.follow(s.maximizedViewId) } : {}),
    // One migration per snapshot (the vertical no-split proposition) — only an old snapshot without the
    // vlNormalized marker is healed by snapping vertical lines fragmented before companion drag (e.g. top 40.6 /
    // bottom 39.5) to the x of the topmost segment. A restore with the marker is identity — it does not rewrite
    // the user's layout.
    // [removal condition] Drop the gate once marker-less snapshots are gone from the field (re-saved with the marker).
    layout: normalize ? normalizeVerticalLines(layout) : layout,
  };
};

// newSplitId is injected by the caller (sessions) — the split id generator. The caller prevents collision with
// preserved ids by raising the counter above the preserved maximum after restore (A5).
export function deserializeWorkspace(
  s: WorkspaceSnapshot,
  newSplitId: () => string,
): Workspace {
  const mint = restoreIds();
  // The spaces first: `activeSpaceId` below names one of them, and an object literal evaluates its
  // properties in source order.
  const spaces = s.contents.map((c) => deserializeContent(c, newSplitId, !s.vlNormalized, mint));
  return {
    id: issueId("workspace"),
    title: s.title,
    root: s.root,
    ...(s.shell ? { shell: s.shell } : {}),
    ...(s.color ? { color: s.color } : {}),
    sidebarOpen: s.sidebarOpen,
    // The stored value of an old snapshot without the marker is not trusted — there is no way to separate the
    // withdrawn era's default (pin@0) from an anchor the user chose, so it is reset once to the default (flow).
    // With the marker present the stored value is honored.
    leftRailPlacement: s.railPlacementNormalized
      ? normalizeRailPlacement(s.leftRailPlacement)
      : DEFAULT_RAIL_PLACEMENT,
    rightOpen: s.rightOpen,
    rightView: s.rightView,
    leftLayout: deserializeSplitTree(s.leftLayout, (g) => g, newSplitId),
    activeSpaceId: mint.follow(s.activeContentId),
    spaces,
  };
}
