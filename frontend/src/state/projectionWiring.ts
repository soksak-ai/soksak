// Real projection wiring (plans/sidebar-projection-spec.md §4) — injects the real registries into
// the pure core (projection.ts). Only this module reads registries and stores directly.
//   - boundViewOf: session active chain -> first binding candidate. Canonical binding = per-space store lock.
//   - realProjectionDeps: contract resolution (contractResolve), rail registration check
//     (viewRegistry), consumes gate (plugins manifest).
//   - projectionFor: derived at read time — never stored (zero dual truth).
//   - startProjectionTracking: session subscription -> focusHistory record/cleanup + projection.changed emit.

import { leavesOf } from "./splitTree";
import { useSessions, type Project } from "./sessions";
import {
  resolveProjection,
  useProjection,
  type BoundView,
  type Projection,
  type ProjectionDeps,
} from "./projection";
import { usePlugins } from "./plugins";
import { getRegisteredView, useViewRegistry } from "../plugins/viewRegistry";
import { resolveFileViewer } from "../plugins/fileViewerRegistry";
import { resolveContractImplementer } from "../plugins/contractResolve";
import { useContractSelection } from "./contractSelection";
import { emitPluginEvent } from "../plugins/hooks";

// Tail of the active chain (active content view) -> declaration summary. Plugin view = sidebar of the
// registered decl, file view = sidebar of the responsible fileViewer (§3.1). No view = null (empty project).
function boundViewInContent(
  project: Project,
  contentId: string,
  viewId?: string,
): BoundView | null {
  const content =
    project.spaces.find((c) => c.id === contentId) ?? null;
  if (!content) return null;
  const groups = leavesOf(content.layout);
  const activeGroup =
    groups.find((g) => g.id === content.activePaneId) ?? groups[0];
  const group = viewId
    ? groups.find((g) => g.tabs.some((v) => v.id === viewId))
    : activeGroup;
  const view = viewId
    ? group?.tabs.find((v) => v.id === viewId)
    : group?.tabs.find((v) => v.id === group.activeTabId);
  if (!view) return null;
  const ctx = { groupId: group?.id ?? null, contentId: content.id };
  if (view.kind === "plugin") {
    const reg = getRegisteredView(`${view.pluginId}.${view.view}`);
    return {
      viewId: view.id,
      ...ctx,
      ownerPluginId: view.pluginId,
      sidebar: reg?.decl.sidebar ?? null,
    };
  }
  const viewer = resolveFileViewer(view.path);
  if (!viewer) return { viewId: view.id, ...ctx, ownerPluginId: "", sidebar: null };
  return {
    viewId: view.id,
    ...ctx,
    ownerPluginId: viewer.pluginId,
    sidebar: viewer.decl.sidebar ?? null,
  };
}

export function boundViewOf(project: Project): BoundView | null {
  const content =
    project.spaces.find((c) => c.id === project.activeSpaceId) ??
    project.spaces[0];
  return content ? boundViewInContent(project, content.id) : null;
}

export function realProjectionDeps(): ProjectionDeps {
  return {
    resolveContract: (req) => resolveContractImplementer(req),
    isRailView: (key) => {
      const reg = getRegisteredView(key);
      return !!reg && reg.decl.placements.includes("rail");
    },
    consumesOf: (pluginId) => {
      const p = usePlugins.getState().plugins[pluginId];
      return (p?.manifest.consumes ?? []).map((c) => c.id);
    },
  };
}

// Current projection of a project — derived at read time. Missing project = null.
export function projectionFor(projectId: string): Projection | null {
  const tab = useSessions.getState().projects.find((t) => t.id === projectId);
  if (!tab) return null;
  const pins =
    useProjection.getState().byProject[projectId]?.pins ?? { left: [], right: [] };
  const content =
    tab.spaces.find((c) => c.id === tab.activeSpaceId) ?? tab.spaces[0];
  const lockedId = content?.railBindingTabId;
  const bound = content
    ? boundViewInContent(tab, content.id, lockedId) ?? boundViewInContent(tab, content.id)
    : null;
  return resolveProjection(projectId, bound, pins, realProjectionDeps());
}

// Session subscription — binding observation (R1: includes tab switches inside a group) + history
// cleanup + project reclaim + events. Once per window (main boot). Returns the unsubscribe function.
export function startProjectionTracking(): () => void {
  // Per-project fingerprint — binding, slot resolution, pins. Emit only when the fingerprint changes
  // (§4.3: binding/slot/pin change — tab switch inside a group, demote<->promote, pin add/remove).
  const last = new Map<string, string>();

  const sync = (tabs: Project[], opts?: { silent?: boolean }) => {
    const proj = useProjection.getState();
    const alive = new Set(tabs.map((t) => t.id));
    for (const pid of Object.keys(proj.byProject)) {
      if (!alive.has(pid)) proj.dropProject(pid);
    }
    for (const pid of [...last.keys()]) {
      if (!alive.has(pid)) last.delete(pid);
    }
    // Emit in one batch outside the sweep loop — a synchronous emit during the sweep would re-enter
    // sync through a subscriber and tangle with history and pin updates.
    const changed: { projectId: string; viewId: string | null }[] = [];
    for (const t of tabs) {
      const candidate = boundViewOf(t);
      const vid = candidate?.viewId ?? null;
      if (candidate?.contentId && vid) {
        // The binding target is always the current active view. Pinning this id across views that
        // share one rail implementation points FLOW position, relation outline, and disclosure state
        // at the previous panel. instanceKey in resolveProjection owns DOM instance stability.
        const locked = t.spaces.find((c) => c.id === candidate.contentId)
          ?.railBindingTabId;
        if (locked !== vid) {
          useSessions.getState().bindContentRail(t.id, candidate.contentId, vid);
        }
        useProjection.getState().noteBinding(t.id, vid);
      }
      const resolved = projectionFor(t.id);
      const fingerprint = JSON.stringify({
        b: resolved?.binding ?? null,
        l: resolved?.left.slots.map((x) => [x.source, x.resolvedRef, x.status]),
        r: resolved?.right?.slots.map((x) => [x.source, x.resolvedRef, x.status]) ?? null,
        p: resolved?.pins ?? null,
      });
      if (last.get(t.id) !== fingerprint) {
        last.set(t.id, fingerprint);
        changed.push({ projectId: t.id, viewId: vid });
      }
      // Drop dead views from the succession material (R6).
      const entry = useProjection.getState().byProject[t.id];
      if (entry && entry.focusHistory.length > 0) {
        const ids = new Set<string>();
        for (const c of t.spaces) {
          for (const g of leavesOf(c.layout)) {
            for (const v of g.tabs) ids.add(v.id);
          }
        }
        for (const v of entry.focusHistory) {
          if (!ids.has(v)) useProjection.getState().forgetView(t.id, v);
        }
      }
    }
    if (!opts?.silent) {
      for (const c of changed) emitPluginEvent("projection.changed", c);
    }
  };

  // Boot observation only seeds the fingerprint and emits nothing — restore must not replay as events (R9).
  sync(useSessions.getState().projects, { silent: true });
  const offSessions = useSessions.subscribe((s) => sync(s.projects));
  // Registry and contract-selection changes also affect slot resolution (demote<->promote, implementer swap) — same sweep.
  const offRegistry = useViewRegistry.subscribe(() =>
    sync(useSessions.getState().projects),
  );
  const offSelection = useContractSelection.subscribe(() =>
    sync(useSessions.getState().projects),
  );
  const offProjection = useProjection.subscribe(() =>
    sync(useSessions.getState().projects),
  );
  return () => {
    offSessions();
    offRegistry();
    offSelection();
    offProjection();
  };
}
