import { currentWindow, appInfo, invoke, dragRegion } from "./framework";
import { execute } from "./commands/registry";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listenThisWindow } from "./lib/windowEvents";
import { addWorkspaceClaimed, closeWorkspaceReleased, useOtherWindowWorkspaces } from "./state/workspaceRegistry";
import { removeRecentWorkspace, useRecentWorkspaces } from "./state/recentWorkspaces";
import { rafThrottle } from "./lib/rafThrottle";
import { railEdgeWidths } from "./ui/railEdges";
import { parkedStyle } from "./lib/layerPark";
import { createRectMotionTracker } from "./lib/layoutRectMotion";
import { timed, useEngineLayoutCost, useRenderCost } from "./lib/mainThreadCost";
import { emitPathsDropped, emitPluginEvent } from "./plugins/hooks";
import { startPointerOrderRepair } from "./lib/pointerOrderRepair";
import { isPrimaryModifier, routeZoom } from "./lib/zoomIntent";
import { beginLayoutMotion, endLayoutMotion } from "./lib/layoutMotion";
import { startSurfaceActivationSync, startViewFocusSync } from "./plugins/viewFocus";
import { safeListen } from "./lib/safeListen";
import { SectionSetHost } from "./components/SectionSetHost";
import { RailGridSurface, type RailGridSurfaceHandle } from "./components/RailGridSurface";
import { RailLinkOverlay } from "./components/RailLinkOverlay";
import { PluginManagerModal } from "./components/PluginManagerModal";
import { ContentTabs } from "./components/ContentTabs";
import { GroupArea, HEADER_PX, PANE_INSET } from "./components/GroupArea";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal";
import { WorkspaceSettingsModal } from "./components/WorkspaceSettingsModal";
import { Icon } from "./ui/icons/Icon";
import { validateWorkspaceRoot } from "./lib/workspaceRoot";
// Wordmark logo — fill inherits currentColor, so it tracks the theme automatically (static trusted asset).
import logoRaw from "./assets/soksak_logo.svg?raw";
import { SettingsModal } from "./components/SettingsModal";
import { ConfirmCloseModal } from "./components/ConfirmCloseModal";
import { RemoteConfirmModal } from "./components/RemoteConfirmModal";
import { RecoverySetupModal } from "./components/RecoverySetupModal";
import { RecoveryEnterModal } from "./components/RecoveryEnterModal";
import { wireRemoteConfirm } from "./state/remoteConfirmWire";
import { installRemoteConfirmDevTrigger } from "./state/remoteConfirmDev";
import { ConsentPreviewHost } from "./components/ConsentPreviewHost";
import { NotifyHost } from "./ui/NotifyHost";
import { MotionDebug } from "./components/MotionDebug";
import { PluginHeaderActions } from "./ui/PluginHeaderActions";
import { useUi } from "./state/ui";
import { useT } from "./i18n";
import { useBootPhase } from "./state/bootPhase";
import {
  allGroups,
  cwdTabOf as resolveCwdTab,
  projectArrangement,
  useSessions,
  webviewDisplayName,
  type Workspace,
  type Pane,
} from "./state/sessions";
import {
  useSettings,
  type TabPosition,
  type RightSidebarMode,
} from "./state/settings";
import { useTheme } from "./state/theme";
import { hasPtyObservation } from "./terminal/ptyObservationStore";
import {
  DEFAULT_RAIL_PLACEMENT,
  railStationFromLeftPx,
  snapRailStation,
} from "./lib/railPlacement";
import { railGeometryScopeId, railPresentation } from "./lib/railMotion";
import { useAppChromeLayoutReflow } from "./lib/appChromeLayoutReflow";
import { useArrangementPhase } from "./components/useArrangementPhase";
import {
  resolvePresentedRailRelation,
  viewIdsOfMoves,
} from "./lib/railArrangement";
import { prepareLayoutChange, viewLayoutChange } from "./lib/layoutTransitionHost";
import { registerLayoutTransitionIntentHost } from "./lib/layoutTransitionIntent";
import { ownsNativeSurfaceFromManifests } from "./lib/nativeSurfaceOwnership";
import { useAddTabIntent } from "./state/addTabIntent";
import { focusedPluginOf, regionPresent, useSectionSets } from "./state/sectionSets";
import "./App.css";

// Pass GroupArea only the public media facts the manifest owns. GroupArea does not read inside the
// framework or the plugin registry; it picks the travel visual owner from this identity set.
const nativeSurfaceViewIds = (content: Workspace["spaces"][number]): string[] => (
  allGroups(content.layout).flatMap((group) => group.tabs
    .filter((view) => ownsNativeSurfaceFromManifests(view.pluginId, view.view))
    .map((view) => view.id))
);

// Left sidebar (file tree) width range in CSS px. The actual width is drag-adjusted (global, persisted in localStorage).
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 640;
const SIDEBAR_DEFAULT = 320;
// Right plugin sidebar width range.
const RIGHT_MIN = 200;
const RIGHT_MAX = 640;
const RIGHT_DEFAULT = 300;
// Left workspace rail width.
// Product layout contract: workspace rail default 54px, drag 44–110px.
const RAIL_MIN = 44;
const RAIL_MAX = 110;
const RAIL_DEFAULT = 54;

// Shared hook for drag-resizable panel width (persisted in localStorage). dir = the side the panel is attached to:
// left (default) grows when the right handle is dragged right; right has a left handle, so the sign is inverted.
function useResizableWidth(
  key: string,
  def: number,
  min: number,
  max: number,
  dir: "left" | "right" = "left",
) {
  const [w, setW] = useState<number>(() => {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : def;
  });
  // begin is reference-stable (useCallback) — passing it as a prop into the memoized WorkspacePlane
  // does not break the boundary (principle 2). The current width is read from a ref.
  const wRef = useRef(w);
  wRef.current = w;
  const begin = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wRef.current;
    const sign = dir === "left" ? 1 : -1;
    // Width state updates once per frame (principle 4) — App-level state makes re-render expensive.
    const commitW = rafThrottle((next: number) => setW(next));
    const onMove = (ev: MouseEvent) =>
      commitW(
        Math.min(max, Math.max(min, startW + sign * (ev.clientX - startX))),
      );
    const onUp = () => {
      commitW.flush(); // Before the listeners are removed — a lost last frame = snapback.
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      endLayoutMotion("resize");
      setW((cur) => {
        localStorage.setItem(key, String(cur));
        return cur;
      });
    };
    // A width drag is a layout motion phase too (hole clipping, native follow) — shared by sidebar, rail and right panel.
    beginLayoutMotion("resize");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // key/min/max/dir are constant at each call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, min, max, dir]);
  return [w, begin] as const;
}

// Body of one workspace (left sidebar + content + right plugin sidebar).
// memo boundary = workspace data boundary (principle 2, docs/PERFORMANCE.md): a store write for workspace X
// preserves the object identity of workspace Y (mapWorkspace), so the Y subtree does not re-render.
// Every prop must be reference- or value-stable — no custom comparator.
const WorkspacePlane = memo(function WorkspacePlane({
  workspace,
  isActiveWorkspace,
  sidebarW,
  rightW,
  rightMode,
  contentTabPosition,
  startResize,
  startRightResize,
}: {
  workspace: Workspace;
  isActiveWorkspace: boolean;
  sidebarW: number;
  rightW: number;
  rightMode: RightSidebarMode;
  contentTabPosition: TabPosition;
  startResize: (e: React.MouseEvent) => void;
  startRightResize: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const setLeftRailPlacement = useSessions((s) => s.setLeftRailPlacement);
  useRenderCost("render.workspace");
  const railPlaneRef = useRef<HTMLDivElement>(null);
  // The rail travels with the panes, on the same interpolation they use.
  //
  // Its width was written by the render and the panes travel over the motion, so between the two was
  // space belonging to nobody: measured 2026-08-17 across all six ways focus can move in a
  // three-pane window, 165 points for 147–181ms every time the region left or arrived. One motion
  // owns the layout, so the rail is given the same tracker rather than a transition of its own —
  // a second timing source would meet the first somewhere in the middle of every change.
  const railMotion = useMemo(() => createRectMotionTracker("rail"), []);
  const railGridSurfaceRef = useRef<RailGridSurfaceHandle>(null);
  const placement = workspace.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT;
  // The plugin of the focused centre view, and the set standing on the left because of it.
  //
  // A plugin with no link has no sidebar at all — not an empty one. Composing nothing and reserving
  // width for it leaves a hole on the screen, and a person reads that as a view that failed to draw.
  const focusedPluginId = useMemo(() => focusedPluginOf(workspace), [workspace]);
  // Where the standing set stands, if one does. Read once for both regions: the left asked this and
  // the right did not until 2026-08-17, so the right opened with nothing in it and reserved its
  // width — the hole this rule exists to prevent, and the empty strip in every capture of that day.
  // Re-read when the sets change, not only when the workspace does.
  const sectionsVersion = useSectionSets((s) => s.sets.length + Object.keys(s.byPlugin).length);
  const leftOpen = useMemo(
    () => regionPresent(workspace.regionOpen.left, "left", focusedPluginId),
    [workspace.regionOpen.left, focusedPluginId, sectionsVersion],
  );
  const rightPresent = useMemo(
    () => regionPresent(workspace.regionOpen.right, "right", focusedPluginId),
    [workspace.regionOpen.right, focusedPluginId, sectionsVersion],
  );

  const activeContent =
    workspace.spaces.find((content) => content.id === workspace.activeSpaceId) ??
    workspace.spaces[0];

  // Fall back to the last settled value so station does not collapse to 0 on an unresolved focus render.
  const lastStationRef = useRef(0);
  // The solver solves the arrangement — single truth for station, layout, produced adjacency and move amounts (never recompute).
  // **Subscribe** to the attach mode and pass it down — reading it through getState skips the redraw when the setting changes.
  const railPullFocused = useSettings((s) => s.railPullFocused);
  const solved = projectArrangement(workspace, lastStationRef.current, railPullFocused);
  lastStationRef.current = solved?.station ?? 0;
  const railGeometryScope = railGeometryScopeId(
    activeContent?.id,
    solved?.cleanLines ?? [0, 100],
  );
  // Arrangement phase (§12-④) — only the pane corridor contracts and expands over 340ms, with the departure and arrival rails on the floor below it.
  // This hook is the only phase tracker, and **the phase also owns what stands on screen** (a solution arriving
  // mid-travel waits in the queue — swapping the display at once makes the running animation jump).
  // Content identity — the per-panel view composition. The phase holds geometry only, so a content change is signalled
  // by this signature and applied at once (the seam for the defect where view open, close and tab switch never appeared).
  const contentKey = useMemo(
    () =>
      activeContent
        ? allGroups(activeContent.layout)
            .map(
              (group) =>
                `${group.id}:${group.activeTabId}:${group.tabs.map((v) => v.id).join("+")}`,
            )
            .join("|")
        : "",
    [activeContent],
  );
  const prepareArrangementTravel = useCallback(
    (from: NonNullable<typeof solved>, to: NonNullable<typeof solved>, signal?: AbortSignal) => {
      const hostWidth = railPlaneRef.current?.getBoundingClientRect().width ?? 0;
      const groups = allGroups(to.displayLayout).map((group) => ({
        id: group.id,
        viewIds: group.tabs.map((view) => view.id),
        panePresentationViewIds: group.tabs
          .filter((view) => view.id === group.activeTabId
            && ownsNativeSurfaceFromManifests(view.pluginId, view.view))
          .map((view) => view.id),
      }));
      return prepareLayoutChange(viewLayoutChange(
        from,
        to,
        groups,
        hostWidth,
        leftOpen ? sidebarW : 0,
      ), signal);
    },
    [leftOpen, sidebarW],
  );
  useLayoutEffect(
    () => registerLayoutTransitionIntentHost<Pane>(workspace.id, {
      prepare: ({ from, to }, signal) => prepareArrangementTravel(from, to, signal),
    }),
    [workspace.id, prepareArrangementTravel],
  );
  const phase = useArrangementPhase(
    solved,
    railGeometryScope,
    contentKey,
    undefined,
    prepareArrangementTravel,
    workspace.id,
    railGridSurfaceRef.current?.candidateParticipant,
  );
  const arrangement = phase.displayed;
  const railCleanLines = arrangement?.cleanLines ?? [0, 100];
  const effectiveStation = arrangement?.station ?? 0;
  const [dragStation, setDragStation] = useState<number | null>(null);
  const renderedStation = dragStation ?? effectiveStation;
  // The renderer and state.tree/pane.list consume the same solver. With no explicit binding it is this solution's
  // focused active tab; a closed or empty panel gives none/0. Group, adjacency and border are never re-decided here.
  const effectiveRailRelation = activeContent
    ? resolvePresentedRailRelation({
        contentId: activeContent.id,
        displayed: arrangement,
        destination: solved,
        bindingTabId: activeContent.railBindingTabId,
        placement: placement.mode,
        railOpen: leftOpen,
        station: renderedStation,
      })
    : null;
  // Rail visual mode (§12-⑤) — pane (like a split window) | ground (floor plane). The toggle is on the slot frame header.
  const railLook = useSettings((s) => s.railLook);
  // Views the phase actually moves — only views of the panels (groups) the solution named. Freeze and veil apply to
  // this set alone: a surface that does not move stays live through the phase and is not even notified.
  const movingViewIds = useMemo(() => {
    if (!activeContent || phase.moves.length === 0) return [];
    return viewIdsOfMoves(
      phase.from?.displayLayout ?? activeContent.layout,
      phase.moves,
    );
  }, [activeContent, phase.from, phase.moves]);
  const movingKey = movingViewIds.join(",");
  // Precondition for gliding (§4.6-5) — glide only when every moving hole surface can be covered by a stand-in.
  // If an uncoverable surface is in the set, that surface is dragged along by sampling for the whole phase, and that
  // stutter was the original complaint. Without cover, do not glide — an instant snap is plain but never ugly.
  //
  // The decision is made **once, at phase start** (phase.glide). Re-evaluating every render flips the rail
  // representation between 1 and 2 instances mid-phase, and in that 1-instance render the standing sidebar commits the
  // new projection and is then pushed into the departing slot — the origin of the measured defect where the departing
  // slot closed while holding the new projection.


  const railTraveling = dragStation === null && phase.traveling && phase.glide;
  // The rail is one persistent DOM node. Settle the target position first, then rewind from the start point with the
  // same FLIP phase as tabs. Duplicating source/target remounts the sidebar views and produces empty frames.
  const rail = railPresentation(
    phase.from?.station ?? renderedStation,
    renderedStation,
    railTraveling,
  );
  // Phase signal (§4.6) — the basis on which the core covers a moving surface with a stand-in. Native surfaces do not
  // move during the phase (the stand-in handles the visuals), so nothing native is driven here.
  useLayoutEffect(() => {
    if (!railTraveling) return;
    beginLayoutMotion("move", movingViewIds, `rail-travel:${movingKey}`);
    return () => endLayoutMotion("move");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railTraveling, movingKey]);
  // Consume the pane grid row contract — inject dimensions from the same source (GroupArea constants + theme
  // paneStyle) into the rail subtree so the rail header aligns with the pane group header row.
  const paneStyle = useTheme((s) => s.spec.chrome.paneStyle);
  const railPaneInset = PANE_INSET[paneStyle] ?? 0;

  // Pin = anchor at the current position / unpin = follow focus (flow). Attaching the rail to the function tab is the default.
  const toggleRailPin = useCallback(() => {
    setLeftRailPlacement(
      workspace.id,
      placement.mode === "pin"
        ? { mode: "flow" }
        : { mode: "pin", station: effectiveStation },
    );
  }, [effectiveStation, placement.mode, workspace.id, setLeftRailPlacement]);

  const startRailStationDrag = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || !leftOpen) return;
      e.preventDefault();
      e.stopPropagation();
      const plane = railPlaneRef.current;
      const rail = e.currentTarget.closest<HTMLElement>(".sidebar");
      if (!plane || !rail) return;
      const planeRect = plane.getBoundingClientRect();
      const offset = e.clientX - rail.getBoundingClientRect().left;
      let next = effectiveStation;
      const resolve = (clientX: number) => {
        const raw = railStationFromLeftPx(
          clientX - planeRect.left - offset,
          planeRect.width,
          sidebarW,
        );
        return snapRailStation(railCleanLines, raw);
      };
      const onMove = (ev: MouseEvent) => {
        next = resolve(ev.clientX);
        setDragStation((current) => (current === next ? current : next));
      };
      const onUp = (ev: MouseEvent) => {
        next = resolve(ev.clientX);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        endLayoutMotion("move");
        setDragStation(null);
        // A drag landing is not a travel phase — sync the display reference point to the pointer position.
        phase.rebase();
        setLeftRailPlacement(workspace.id, { mode: "pin", station: next });
      };
      // A hand drag is a layout motion phase too — it gets the same signals as automatic travel (hole clipping, native follow).
      beginLayoutMotion("move", undefined, "station-drag");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [
      effectiveStation,
      phase.rebase,
      workspace.id,
      leftOpen,
      railCleanLines,
      setLeftRailPlacement,
      sidebarW,
    ],
  );
  // On a content tab switch the inactive slot hides while keeping its DOM lifetime. That visibility change lands in the
  // DOM in this render commit, so right after the commit (useLayoutEffect, before paint) the core fires layout.reflow
  // → the plugin owning the native webview (browser) re-snaps bounds once to the final anchor and reacts to clicks
  // immediately. The switch signal (view.activated) is a store diff microtask and runs before the commit, so it is
  // unusable here (measuring from it reads the old position and the webview lags one beat).
  //
  // A tab switch (replacing the active view inside a panel) is the same edge — contentKey includes it. Without it two
  // defects arrive together: (1) a newly activated view has no snap, so the glide precondition of the next journey
  // breaks and the whole grid teleports (2) a surface returning from parking is not re-snapped to the final anchor and
  // lags one beat (measured by the user: choosing another tab in a panel with several browser tabs looks off and flickers).
  // The rail is measured on the commit that changed it, the same beat the panes are measured on. A
  // render that changes nothing about its box produces the same values and starts no motion.
  useLayoutEffect(() => {
    timed("rail.flush", () => railMotion.flush(phase.replacing ? "replace" : "animate"));
  }, [leftOpen, sidebarW, renderedStation, railLook, railTraveling, phase.replacing, railMotion]);
  useLayoutEffect(() => {
    timed("plugins.reflow", () =>
      emitPluginEvent("layout.reflow", { activeSpaceId: workspace.activeSpaceId }),
    );
  }, [
    contentKey,
    activeContent?.activePaneId,
    activeContent?.maximizedTabId,
    workspace.activeSpaceId,
    leftOpen,
    isActiveWorkspace,
    renderedStation,
    railTraveling,
    sidebarW,
    contentTabPosition,
  ]);
  // The engine's half of the same commit, measured last so what it forces is the DOM every flush
  // above has already written.
  useEngineLayoutCost();
  return (
    <div
      className="workspace-plane"
      // Anchor of address axiom A1 — the chrome nodes inside this plane exist once per workspace.
      // The address must include the workspace for rail/left to resolve to exactly one (collectExposed reads it).
      data-workspace-plane={workspace.id}
      data-workspace-active={isActiveWorkspace ? "1" : undefined}
      // An inactive workspace is hidden by ordinary DOM visibility rather than unmounted. Visibility of surfaces outside
      // the document is the separate responsibility of the framework consuming the view.parked/content-view host contract.
      style={parkedStyle(isActiveWorkspace)}
    >
      {/* The upper content tabs stay outside the rail; only the selected panel grid shares a coordinate system with the rail. */}
      <div
        className={`content${contentTabPosition === "left" ? " space-tabs-left" : ""}`}
      >
        {workspace.rootMissing && (
          <div className="root-missing-banner" data-node="banner/root-missing">
            {t("workspace.rootMissing", { root: workspace.root })}
          </div>
        )}
        <ContentTabs
          workspace={workspace}
          vertical={contentTabPosition === "left"}
        />
        <RailGridSurface
          ref={railGridSurfaceRef}
          traveling={railTraveling}
          starting={phase.starting}
          relationOverlay={
            !phase.replacing && activeContent && effectiveRailRelation ? (
              <RailLinkOverlay
                key={`${effectiveRailRelation.state.relationId}|${effectiveRailRelation.station}|${effectiveRailRelation.targetRect?.left ?? "none"}|${effectiveRailRelation.targetRect?.top ?? "none"}|${effectiveRailRelation.targetRect?.width ?? "none"}|${effectiveRailRelation.targetRect?.height ?? "none"}`}
                contentId={activeContent.id}
                relation={effectiveRailRelation.state}
                railWidth={sidebarW}
                railStation={effectiveRailRelation.station}
                targetRect={effectiveRailRelation.targetRect}
                projected={arrangement?.swapped ?? false}
              />
            ) : undefined
          }
          railPlane={
            <div
              ref={railPlaneRef}
              className="left-rail-plane"
              data-node="rail/plane"
              style={
                {
                  "--pane-inset": `${railPaneInset}px`,
                  "--header-h": `${HEADER_PX}px`,
                } as React.CSSProperties
              }
            >
              {phase.replacing
                ? null
                : <div
                  key={rail.key}
                  ref={railMotion.ref}
                  className={`sidebar rail-${railLook}`}
                  data-wv-occlusion="rail"
                  data-node="rail/left"
                  data-region="left"
                  data-region-open={String(workspace.regionOpen.left)}
                  data-rail-role={rail.visible ? "resting" : "traveling-hidden"}
                  data-focus-lighting="exempt"
                  // Ownership of the vertical border depends on station (at an edge the outer side is omitted — §B2).
                  // With the deciding axis only inside an inline style, the contract cannot state its law —
                  // publish the axis so it is readable from outside (consumed by borderContract rail-pane-*).
                  data-station={rail.station}
                  onMouseDown={(e) => {
                          // §12-① header = move handle — grabbing anywhere on the frame header starts a station drag.
                          // Interactive controls on the header (buttons) are excluded.
                          const t = e.target as HTMLElement;
                          if (
                            t.closest(".projection-header") &&
                            !t.closest("button")
                          ) {
                            startRailStationDrag(e);
                          }
                        }}
                  style={
                    {
                      // One inset nearer the view it serves, which is always the one on its
                      // right. Standing between two of them with the same gap on each side,
                      // nothing on the screen marks it as one view's rather than the other — measured
                      // 2026-08-17: the left column ended at 414, the sidebar held 420..580,
                      // and the pane it served began at 586. Six points each way.
                      left: `calc(${rail.station}% - ${(sidebarW * rail.station) / 100}px + var(--pane-inset, 0px))`,
                      width: leftOpen ? sidebarW : 0,
                      borderLeftWidth: railEdgeWidths(
                        railLook,
                        leftOpen,
                        rail.station,
                        paneStyle,
                      ).left,
                      borderRightWidth: railEdgeWidths(
                        railLook,
                        leftOpen,
                        rail.station,
                        paneStyle,
                      ).right,
                    } as React.CSSProperties
                  }
                >
                  {/* The band takes its shape from the motion; what stands in it keeps its own.
                      A region that opens interpolates its width so the panes beside it are adjacent
                      in every frame of the way — and a section inside it that followed that width
                      would lay itself out again on each of those frames. Measured 2026-08-17: the
                      window stopped drawing for 184ms on a move that only travelled the rail, with
                      no page in it at all. So the band grows and the section keeps the width it will
                      have, clipped by the band until the band is that wide. */}
                  <div className="rail-content" style={{ width: sidebarW }}>
                    <SectionSetHost
                      region="left"
                      workspace={workspace}
                      paneId={cwdTabOf(workspace) ?? ""}
                      focusedPluginId={focusedPluginId}
                    />
                  </div>
                  {leftOpen && (
                    <div className="left-rail-controls">
                      <button
                        type="button"
                        className={`left-rail-pin${placement.mode === "pin" ? " active" : ""}`}
                        title={
                          placement.mode === "pin"
                            ? t("sidebar.unpin")
                            : t("sidebar.pin")
                        }
                        onClick={toggleRailPin}
                      >
                        <Icon
                          name={placement.mode === "pin" ? "pin-filled" : "pin"}
                          size="sm"
                        />
                      </button>
                    </div>
                  )}
                  {leftOpen && (
                    <div
                      className="sidebar-resizer"
                      data-wv-occlusion="sidebar-resizer"
                      onMouseDown={startResize}
                      title={t("sidebar.resize")}
                    />
                  )}
                </div>}
            </div>
          }
        >
          {workspace.spaces.map((c) => {
            const isActiveContent = c.id === workspace.activeSpaceId;
            return (
              <div
                key={c.id}
                className="space-plane"
                // Inactive content keeps its DOM lifetime and box; only visibility is turned off.
                style={parkedStyle(isActiveContent)}
              >
                <GroupArea
                  content={c}
                  projectId={workspace.id}
                  nativeSurfaceViewIds={nativeSurfaceViewIds(c)}
                  surfaceActive={isActiveWorkspace && isActiveContent}
                  // The solution determines the arrangement — inactive content keeps its canonical layout (no rail).
                  // Cells blocked by how far the rail could not go — they do not move, but must dim to show which panel is active.
                  //
                  // Taken from the solution the screen draws — the same place as the effective binding. One box comes
                  // from one solution: attaching old geometry to a new fact yields a picture that is from no solution
                  // at all. A solution where only focus changed is accepted by the phase at once (arrangementKey signs
                  // that fact too — otherwise this reads the old value forever).
                  betweenIds={isActiveContent ? (arrangement?.betweenIds ?? []) : []}
                  // Dimming follows the same solution — if geometry follows the phase but dimming changes at once,
                  // the frozen snapshot becomes unusable at journey start and nothing is left to cover the surface.
                  focusedPaneId={isActiveContent ? arrangement?.focusId : undefined}
                  displayLayout={
                    isActiveContent ? arrangement?.displayLayout : undefined
                  }
                  moves={isActiveContent && railTraveling ? phase.moves : undefined}
                  travel={
                    isActiveContent && railTraveling
                      ? {
                          from: phase.from?.station ?? renderedStation,
                          to: renderedStation,
                        }
                      : undefined
                  }
                  replaceGeometry={isActiveContent && phase.replacing}
                  railStation={isActiveContent ? renderedStation : 0}
                  // The maximize fact comes from the **same solution** as station — mixing them makes the render throw.
                  displayMaximizedId={isActiveContent ? (arrangement?.maximizedId ?? null) : undefined}
                  railWidthPx={
                    isActiveContent && leftOpen ? sidebarW : 0
                  }
                />
              </div>
            );
          })}
        </RailGridSurface>
      </div>

      {/* Right plugin sidebar (⌥⌘B). Closed = width 0 (not unmounted — keep-alive). */}
      {rightPresent && (
        <div
          className="sidebar-right-resizer"
          data-node="sidebar/right/resizer"
          data-wv-occlusion="sidebar-resizer"
          style={{ right: rightW - 2 }}
          onMouseDown={startRightResize}
          title={t("plugin.sidebar.resize")}
        />
      )}
      <div
        className={`sidebar-right${rightPresent ? " open" : ""}${rightMode === "push" ? " push" : ""}`}
        data-node="sidebar/right"
        data-region="right"
        data-region-open={String(workspace.regionOpen.right)}
        data-wv-occlusion="sidebar-right"
        data-focus-lighting="exempt"
        style={{
          width: rightPresent ? rightW : 0,
          borderLeftWidth: rightPresent ? 1 : 0,
        }}
      >
        <SectionSetHost
          region="right"
          workspace={workspace}
          paneId={cwdTabOf(workspace) ?? ""}
          focusedPluginId={focusedPluginId}
        />
      </div>
    </div>
  );
});

// The terminal pane the workspace sidebar (file tree) follows (= the current cwd source). The pure resolver is
// sessions.cwdTabOf — here it is called with the PTY observation predicate (hasPtyObservation) injected.
// No core/plugin terminal distinction — any view driving the PTY substrate (one that has an observation) is followed.
const cwdTabOf = (workspace: Workspace): string | undefined =>
  resolveCwdTab(workspace, hasPtyObservation);

// Build identity badge: DEV (dev identity) / DEBUG (debug bundle soksak-debug) / none (release).
// The axis is identity, not the load mode (HMR or bundle). It used to be "DEV only when HMR", so a bundle build with
// the same dev identity had no badge and was visually indistinguishable from a release (measured: the user mistook it
// for not being a dev build). HMR runs only under dev identity, so it maps to DEV immediately; a bundle is separated
// by the app name (getName) — productName encodes the identity as soksak-dev / soksak-debug / soksak.
function BuildBadge() {
  const t = useT();
  const [label, setLabel] = useState<string | null>(
    import.meta.env.DEV ? "DEV" : null,
  );
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let alive = true;
    appInfo
      .name()
      .then((name) => {
        if (!alive) return;
        if (name.includes("debug")) setLabel("DEBUG");
        else if (name.includes("dev")) setLabel("DEV");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  // The badge is the handle for the motion observation panel — it exists only under a dev identity, so a release has
  // no such surface at all. A human slows motion here and pauses it, then ui.snapshot.dom reads that same moment.
  const [debugOpen, setDebugOpen] = useState(false);
  if (!label) return null;
  return (
    <span className="dev-badge-wrap">
      <button
        type="button"
        data-node="dev-badge"
        className={`dev-badge${label === "DEBUG" ? " debug" : ""}${debugOpen ? " on" : ""}`}
        title={t("status.motionDebug")}
        onClick={() => setDebugOpen((v) => !v)}
      >
        {label}
      </button>
      {debugOpen && <MotionDebug onClose={() => setDebugOpen(false)} />}
    </span>
  );
}

// Webview recovery exhaustion badge — of the health transitions the core (webview_health) emit_to'd this window, only
// open (automatic recovery limit exhausted) is reported as a non-blocking badge. No blocking dialog — one child's crash
// must not block a multi-window setup with a modal. The reload action = the same core path as webview.recover
// (breaker reset + in-place reload). A recovering/closed transition removes that label's badge (both a normal return
// and a resumed recovery end the badge's reason).
// Boot phase badge — a faint corner indicator that restore and plugin preparation are in progress (prevents mistaking
// the window for empty). It disappears at ready. Not clickable, non-blocking (no pointer-events).
function BootPhaseBadge() {
  const phase = useBootPhase((s) => s.phase);
  const t = useT();
  if (phase === "ready") return null;
  return (
    <div className="boot-phase" data-node="boot-phase">
      <span className="boot-phase-dot" />
      {phase === "restoring" ? t("boot.restoring") : t("boot.activating")}
    </div>
  );
}

function WebviewHealthBadges() {
  const t = useT();
  // The badge is a user surface — resolve the tab display name instead of the raw label (b-<window>-<viewId>)
  // (webviewDisplayName). Identification (key, data-node, recover argument) keeps the label — the machine path is unchanged.
  const workspaces = useSessions((s) => s.workspaces);
  const [openLabels, setOpenLabels] = useState<string[]>([]);
  useEffect(() => {
    return listenThisWindow<{ label: string; state: string }>(
      "webview-health",
      (e) => {
        const { label, state } = e.payload;
        setOpenLabels((prev) =>
          state === "open"
            ? prev.includes(label)
              ? prev
              : [...prev, label]
            : prev.filter((l) => l !== label),
        );
      },
    );
  }, []);
  if (openLabels.length === 0) return null;
  return (
    <div className="webview-health-badges">
      {openLabels.map((label) => (
        <div key={label} className="webview-health-badge">
          <span>
            {t("webview.exhausted", { label: webviewDisplayName(label, workspaces) })}
          </span>
          <button
            type="button"
            data-node={`webview/recover/${label}`}
            onClick={() => {
              void invoke("webview_recover", { label }).catch((err) =>
                console.error("webview manual recovery failed:", err),
              );
            }}
          >
            {t("webview.recoverAction")}
          </button>
          <button
            type="button"
            aria-label={t("common.cancel")}
            onClick={() =>
              setOpenLabels((prev) => prev.filter((l) => l !== label))
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function App() {
  const t = useT();
  const settingsSection = useUi((s) => s.settingsSection);
  const setSettingsSection = useUi((s) => s.setSettingsSection);
  const workspaceTabPosition = useSettings((s) => s.workspaceTabPosition);
  const contentTabPosition = useSettings((s) => s.contentTabPosition);
  const rightSidebarMode = useSettings((s) => s.rightSidebarMode);

  // The theme system (token slots) is the single source — the theme engine applies CSS variables and structural attributes.
  const effectiveMode = useTheme((s) => s.effectiveMode);
  const toggleMode = useTheme((s) => s.toggleMode);
  const reloadThemes = useTheme((s) => s.reload);
  const isDark = effectiveMode === "dark";

  // Scan external themes (~/.soksak/themes) once at startup.
  useEffect(() => {
    reloadThemes().catch((e) => console.error("theme scan failed:", e));
  }, [reloadThemes]);

  // Icon button round box — CSS branches on a root attribute (same shape as data-pane-style).
  const iconBox = useSettings((s) => s.iconBox);
  useEffect(() => {
    document.documentElement.dataset.iconBox = iconBox ? "on" : "off";
  }, [iconBox]);

  // Focus group display style (outline|corners) — CSS branches on a root attribute.
  const focusIndicator = useSettings((s) => s.focusIndicator);
  useEffect(() => {
    document.documentElement.dataset.focusInd = focusIndicator;
  }, [focusIndicator]);

  // Remote destructive confirm wiring (phone-link safety model) — connect what the core emits
  // ("remote-confirm-request") to the store queue, and the decision sink to remote_confirm_resolve (the desktop is the single authority). Once at boot.
  useEffect(() => wireRemoteConfirm(), []);
  // The active workspace/space/pane/tab chain and the real keyboard focus are one contract.
  // Do not autofocus on mount; pass only the latest active view intent to the provider.
  useEffect(() => startViewFocusSync(), []);
  // The other direction: a surface reports it was clicked and the session follows. A view on a
  // native surface receives its own clicks and the document never sees them.
  useEffect(
    () => startSurfaceActivationSync((event, onLabel) =>
      safeListen<{ label?: string }>(event, (e) => {
        const label = e.payload?.label;
        if (label) onLabel(label);
      }),
    ),
    [],
  );
  // Ghost hold recovery — blocks a lost mouseup from a window-activating click from spreading into a terminal drag selection.
  useEffect(() => startPointerOrderRepair(), []);

  // Dev-only mock trigger — opens the modal without a live phone for visual verification (import.meta.env.DEV gate).
  // Installs nothing in a production bundle (DEV=false). window.__soksakMockRemoteConfirm() emits a mock request.
  useEffect(() => installRemoteConfirmDevTrigger(), []);

  // Global font family for the app UI (app chrome) — owned by the core (applied through inheritance). The size axis
  // (appFontSize) was removed: it was a dead half (px chrome did not scale, surfaces own their own), replaced by window zoom + view zoom.
  const appFontFamily = useSettings((s) => s.appFontFamily);
  useEffect(() => {
    document.documentElement.style.setProperty("--app-font", appFontFamily);
  }, [appFontFamily]);
  // Not wired: the fact that a content view took focus.
  //
  // **A click inside a guest never arrives at the host.** A native surface draws in another process,
  // so its mousedown does not cross into this document — pressing the browser does not move the
  // binding. The only fact the host can receive is that the surface took focus, which is
  // CONTENT_VIEW_EVENT.activated.
  //
  // Nothing emits it on this build (measured 2026-08-16: no Go source names it). What stood here was
  // a listener that resolved the payload through `getWebContentsId`, a method of the tag the
  // preceding implementation ran on and of no element here — so it resolved nothing, every time,
  // silently. A listener that cannot succeed reads from outside exactly like a working feature, so
  // it is gone rather than kept.
  //
  // The plugin that owns the surface is the one that can see the click. Do not borrow the OS (A27).

  // The gutter highlight bar is not drawn here — a DOM highlight being covered by a surface is a matter for the
  // framework whose content is outside the document, and that framework subscribes to the hover state and draws it
  // its own way (its adapter's install). The core holds the hover fact alone (useGutterHover).

  // Minimal subscription principle (docs/PERFORMANCE.md 1): per-field and per-action selectors only — no bare hook.
  // A zustand action is a stable reference fixed at create(), so an action selector causes no re-render.
  const workspaces = useSessions((s) => s.workspaces);
  const activeId = useSessions((s) => s.activeId);
  const setActive = useSessions((s) => s.setActive);
  const toggleRegion = useSessions((s) => s.toggleRegion);
  const addViewToGroup = useSessions((s) => s.addViewToGroup);
  const closeView = useSessions((s) => s.closeView);
  // Target workspace id for the workspace settings modal (name/color).
  const [workspaceSettingsFor, setWorkspaceSettingsFor] = useState<string | null>(
    null,
  );
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const activeWorkspace = workspaces.find((t) => t.id === activeId);

  // The spawn options provider is registered by the main.tsx boot (before render) — an effect (after
  // mount) runs later than the first spawn from a child pane ref, which was the latent cause of the
  // first terminal starting with no cwd (at home).

  // Drag-adjusted panel widths (global, persisted in localStorage).
  const [sidebarW, startResize] = useResizableWidth(
    "sidebarW",
    SIDEBAR_DEFAULT,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
  );
  const [railW, startRailResize] = useResizableWidth(
    "railW",
    RAIL_DEFAULT,
    RAIL_MIN,
    RAIL_MAX,
  );
  // The workspace tab rail is app chrome outside WorkspaceSurface. A top↔left swap and a rail width change also alter the
  // inner content slot geometry, so that commit is declared as the shared reflow event.
  useAppChromeLayoutReflow(
    [workspaceTabPosition, railW].join(":"),
    activeWorkspace?.activeSpaceId ?? null,
  );
  const [rightW, startRightResize] = useResizableWidth(
    "rightSidebarW",
    RIGHT_DEFAULT,
    RIGHT_MIN,
    RIGHT_MAX,
    "right",
  );

  // The right sidebar (.sidebar-right) is a DOM overlay above the full-size browser webview
  // (position:absolute, z-index 20). Reporting its rectangle as a "hole" to the native hit_test keeps scrolls and
  // clicks in that area from leaking to the browser below; the DOM (sidebar) receives them. The webview stays
  // full size (the old webview width clamp workaround was removed — see browser.rs).
  // In push mode the sidebar takes space in flow (content and webview are already narrower) → no overlay hole needed.
  // The same presence rule as the plane draws by. A hole reported for a region that is open with
  // nothing standing in it takes clicks away from the surface underneath for a strip nobody sees.
  const activeFocusedPlugin = useMemo(
    () => focusedPluginOf(activeWorkspace),
    [activeWorkspace],
  );
  const activeSections = useSectionSets((s) => s.sets.length + Object.keys(s.byPlugin).length);
  const rightRect = useMemo(
    () =>
      regionPresent(activeWorkspace?.regionOpen.right ?? false, "right", activeFocusedPlugin) &&
      rightSidebarMode !== "push"
        ? rightW
        : 0,
    [activeWorkspace, activeFocusedPlugin, activeSections, rightSidebarMode, rightW],
  );
  useLayoutEffect(() => {
    // Opening, closing and widening the sidebar is **the layout being laid out again** — publish that fact. What to
    // do with it is up to the listener (a framework with surfaces outside the document resends its hole list, and a
    // plugin re-measures its own surface).
    //
    // Do not call the hole API here: calling it puts the hole concept into the core, and that line would then run in
    // a framework that has no such concept.
    //
    // Notify on the frame *after* the layout commits — before rAF the sidebar width is not applied yet and the
    // measurer reads the old rect.
    const notify = () => emitPluginEvent("layout.reflow", { activeSpaceId: activeWorkspace?.activeSpaceId ?? null });
    const raf = requestAnimationFrame(notify);
    // A window resize also moves the sidebar rect (right edge fixed, height) — notify again.
    const onWinResize = () => requestAnimationFrame(notify);
    window.addEventListener("resize", onWinResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onWinResize);
    };
    // rightRect is the single derivation of the right region being open and rightW — notify again when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightRect]);

  // The core does not own terminal theming or session disposal — the terminal plugin applies app theme tokens to its
  // own view's xterm theme and cleans up the PTY session itself on view unmount (PluginViewHost).

  // Keyboard shortcuts (capture phase → ahead of xterm). Relative to the active view of the active workspace.
  // ⌘D split left/right / ⌘⇧D split top/bottom / ⌘W close view (pane→view) / ⌘T new terminal / ⌘B sidebar.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      // ⌘±/0 = zoom intent (3 platforms: mac = ⌘, Win/Linux = Ctrl — handled before the metaKey guard of the
      // remaining shortcuts so the Ctrl path works). Focus determines the scope.
      if (
        isPrimaryModifier(e) &&
        !e.shiftKey &&
        !e.altKey &&
        (key === "=" || key === "+" || key === "-" || key === "0")
      ) {
        e.preventDefault();
        routeZoom(key === "-" ? "out" : key === "0" ? "reset" : "in");
        return;
      }
      if (!e.metaKey) return;
      // ⌘N new window (independent workspace) — workspace-independent, so handled first.
      if (key === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        invoke("window_create").catch((err) => console.error("new window failed:", err));
        return;
      }
      const s = useSessions.getState();
      const workspace = s.workspaces.find((t) => t.id === s.activeId);
      if (!workspace) return;
      const content =
        workspace.spaces.find((c) => c.id === workspace.activeSpaceId) ??
        workspace.spaces[0];
      if (!content) return;
      // ⌥⌘B right plugin sidebar. With ⌥ the e.key is a composed character ("∫"), so the check uses e.code.
      if (e.altKey && !e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        toggleRegion(workspace.id, "right");
        return;
      }
      const groups = allGroups(content.layout);
      const grp =
        groups.find((g) => g.id === content.activePaneId) ?? groups[0];
      const view = grp?.tabs.find((v) => v.id === grp.activeTabId);
      if (key === "w" && !e.shiftKey) {
        // ⌘W closes the active view (core terminal pane splitting removed — view-level close only).
        e.preventDefault();
        if (view) closeView(workspace.id, view.id);
      } else if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        // ⌘T opens the add-tab menu on the active pane, and the person picks.
        //
        // It opened a terminal until 2026-08-16, resolved through a contract id the core spelled
        // out. A tab is the frame's, which the core owns; which content fills it is not, and a
        // plugin's own spec is not the core's to name (PLUGIN-CONTRACT P5). The menu is the program
        // registry's projection, so the core names nothing and an empty registry draws no menu.
        const space = workspace.spaces.find((c) => c.id === workspace.activeSpaceId);
        if (space?.activePaneId) useAddTabIntent.getState().open(space.activePaneId);
      } else if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleRegion(workspace.id, "left");
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeView, addViewToGroup, toggleRegion]);

  // Paths dropped on this window are published. What a drop means is not settled here.
  //
  // The core typed them into the active terminal, shell-escaped — which is a decision about what a
  // drop is for, and it belonged to whichever plugin was drawing that pane (CORE-CENSUS 3). A
  // subscriber that wants the old behaviour writes it; one that wants to open an editor writes
  // that instead, and both can be installed at once.
  useEffect(() => {
    const unlisten = currentWindow().onDragDrop((e) => {
      const event = e as { payload: { type: string; paths?: string[] } };
      if (event.payload.type !== "drop") return;
      const { paths } = event.payload;
      if (!paths || paths.length === 0) return;
      const s = useSessions.getState();
      const proj = s.workspaces.find((t) => t.id === s.activeId);
      emitPathsDropped({
        projectId: proj?.id ?? null,
        paneId: proj ? (cwdTabOf(proj) ?? null) : null,
        paths,
      });
    });
    return () => {
      unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  // Workspace tab list (the same markup is reused for the horizontal top and vertical left placements).
  // Double click = workspace settings modal (name + identifying color — replaces inline rename).
  const workspaceTabsList = (
    <>
      {workspaces.map((proj) => (
        <div
          key={proj.id}
          className={`workspace-tab${proj.id === activeId ? " active" : ""}`}
          onClick={() => setActive(proj.id)}
          onDoubleClick={() => setWorkspaceSettingsFor(proj.id)}
        >
          {proj.color && (
            <span className="workspace-tab-dot" style={{ background: proj.color }} />
          )}
          <span className="workspace-tab-title">{proj.title}</span>
          {workspaces.length > 1 && (
            <button
              type="button"
              className="icon-btn icon-btn--mini workspace-tab-close"
              title={t("workspace.close")}
              onClick={(e) => {
                e.stopPropagation();
                void closeWorkspaceReleased(proj.id); // P6: a successful close releases the global claim
              }}
            >
              <Icon name="close" size="md" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="icon-btn workspace-tab-add"
        data-node="workspace/add"
        title={t("workspace.new")}
        onClick={() => setNewWorkspaceOpen(true)}
      >
        <Icon name="add" />
      </button>
    </>
  );

  // Left rail: chip width tracks the rail width (adaptive). Labels ellipsize; shrunk to the minimum width (RAIL_MIN)
  // only the first character shows (no ellipsis). Double click = workspace settings (name/color), right click = close.
  const railAtMin = railW <= RAIL_MIN;
  const otherWorkspaces = useOtherWindowWorkspaces();
  const recentAll = useRecentWorkspaces();
  // Recents open nowhere = all recents − this window's roots − other windows' roots.
  const openRoots = new Set([
    ...workspaces.map((p) => p.root),
    ...otherWorkspaces.map((o) => o.root),
  ]);
  const recentClosed = recentAll.filter((r) => !openRoots.has(r.root));
  const workspaceRailList = (
    <>
      {workspaces.map((proj) => (
        <div
          key={proj.id}
          className={`rail-chip${proj.id === activeId ? " active" : ""}`}
          title={proj.title}
          style={
            proj.color
              ? { borderColor: proj.color, color: proj.color }
              : undefined
          }
          onClick={() => setActive(proj.id)}
          onDoubleClick={() => setWorkspaceSettingsFor(proj.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (workspaces.length > 1) void closeWorkspaceReleased(proj.id); // P6 release included
          }}
        >
          <span className="rail-chip-label">
            {railAtMin ? ([...proj.title][0] ?? "") : proj.title}
          </span>
        </div>
      ))}
      {/* Workspaces of other windows (the global registry) — every workspace is listed in one list (after
          mine, before "+" — the user-fixed order s,p,+). Dotted and damped styles mark the distinction.
          Click = focus the owning window (P6: move instead of a duplicate open). */}
      {otherWorkspaces.map((o) => {
        const name = o.root.split("/").filter(Boolean).pop() ?? o.root;
        return (
          <div
            key={o.root}
            className="rail-chip other"
            data-node={`rail/other/${name}`}
            title={t("workspace.otherWindow", { window: o.window, root: o.root })}
            onClick={() => void invoke("window_focus", { label: o.window })}
          >
            <span className="rail-chip-label">
              {railAtMin ? ([...name][0] ?? "") : name}
            </span>
          </div>
        );
      })}
      {/* Recent workspaces open in no window — offered as rail buttons.
          Click = open in this window (through the P6 gate). A lost root self-heals out of the list by removal. */}
      {recentClosed.map((r) => {
        const name = r.alias || (r.root.split("/").filter(Boolean).pop() ?? r.root);
        return (
          <div
            key={r.root}
            className="rail-chip recent"
            data-node={`rail/recent/${name}`}
            title={t("workspace.recentOpen", { root: r.root })}
            onClick={() => {
              void (async () => {
                try {
                  await validateWorkspaceRoot(r.root);
                } catch {
                  console.warn(`recent workspace root missing — removed from the list: ${r.root}`);
                  void removeRecentWorkspace(r.root);
                  return;
                }
                await addWorkspaceClaimed({ root: r.root, alias: r.alias });
              })();
            }}
          >
            <span className="rail-chip-label">
              {railAtMin ? ([...name][0] ?? "") : name}
            </span>
          </div>
        );
      })}
      <button
        type="button"
        className="rail-add"
        data-node="rail/add"
        title={t("workspace.new")}
        onClick={() => setNewWorkspaceOpen(true)}
      >
        <Icon name="add" size="lg" />
      </button>
    </>
  );

  return (
    <div className="app-root">
      {/* Overlay titlebar: logo (fixed at the front) + workspace tabs. Dragging the empty area moves the window. */}
      <div className="titlebar" data-node="titlebar" {...dragRegion}>
        {/* The logo is fixed right after the traffic lights (82px) — tabs always stack after the logo.
            pointer-events:none keeps it from intercepting the window drag. */}
        <span
          className="titlebar-logo"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: logoRaw }}
        />
        {/* Build identity badge (DEV=HMR / DEBUG=debug bundle) — fixed right after the logo. Workspace
            tabs (top mode) stack after it. Release (soksak) has no badge. */}
        <BuildBadge />
        {workspaceTabPosition === "top" ? (
          <div className="workspace-tabs" {...dragRegion}>
            {workspaceTabsList}
          </div>
        ) : (
          /* Left mode: the titlebar has no tabs, only the drag region (tabs move to the left rail). */
          <div className="workspace-tabs" {...dragRegion} />
        )}
        <div className="titlebar-right">
          <PluginHeaderActions />
          <button
            type="button"
            className={`icon-btn sidebar-toggle${activeWorkspace?.regionOpen.left ? " active" : ""}`}
            data-node="titlebar/region/left"
            title={t("sidebar.toggle")}
            aria-label={t("sidebar.toggle")}
            onClick={() => activeWorkspace && toggleRegion(activeWorkspace.id, "left")}
          >
            <Icon name="panel-left" />
          </button>
          <button
            type="button"
            className={`icon-btn sidebar-toggle${activeWorkspace?.regionOpen.right ? " active" : ""}`}
            data-node="titlebar/region/right"
            title={t("plugin.sidebar.toggle")}
            aria-label={t("plugin.sidebar.toggle")}
            onClick={() =>
              activeWorkspace && toggleRegion(activeWorkspace.id, "right")
            }
          >
            <Icon name="panel-right" />
          </button>
          <button
            type="button"
            className="icon-btn orch-open"
            data-node="orch-open"
            title={t("orch.open")}
            aria-label={t("orch.open")}
            onClick={() => void execute("window.open", { mode: "orchestrator" }, { remote: false })}
          >
            <Icon name="browser" />
          </button>
          <button
            type="button"
            className="icon-btn theme-toggle"
            data-node="theme-toggle"
            title={isDark ? t("theme.lightPreset") : t("theme.darkPreset")}
            aria-label={t("theme.toggle")}
            onClick={toggleMode}
          >
            <Icon name={isDark ? "sun" : "moon"} />
          </button>
          <button
            type="button"
            className="icon-btn settings-toggle"
            data-node="settings-open"
            title={t("settings.open")}
            aria-label={t("settings.open")}
            onClick={() => setSettingsSection("general")}
          >
            <Icon name="settings" />
          </button>
        </div>
      </div>

      {settingsSection !== null && (
        <SettingsModal
          initialSection={settingsSection}
          onClose={() => setSettingsSection(null)}
        />
      )}
      <ConsentPreviewHost />
      <PluginManagerModal />
      {newWorkspaceOpen && (
        <NewWorkspaceModal onClose={() => setNewWorkspaceOpen(false)} />
      )}
      {workspaceSettingsFor && (
        <WorkspaceSettingsModal
          projectId={workspaceSettingsFor}
          onClose={() => setWorkspaceSettingsFor(null)}
        />
      )}
      <ConfirmCloseModal />
      <RemoteConfirmModal />
      <RecoverySetupModal />
      <RecoveryEnterModal />

      {/* Body: in left mode, a vertical workspace rail + the content row. */}
      <div className={`app-body${workspaceTabPosition === "left" ? " with-rail" : ""}`}>
        {workspaceTabPosition === "left" && (
          <>
            <div className="workspace-rail" style={{ width: railW }}>
              {workspaceRailList}
            </div>
            <div
              className="workspace-rail-resizer"
              onMouseDown={startRailResize}
              title={t("sidebar.resize")}
            />
          </>
        )}
        {/* Zero workspaces = an exception state only (P6 degradation, a restore drop) — open and create are
            control-plane surfaces. An empty workspace window has no create path (window.new requires root),
            so only the notice remains. */}
        {workspaces.length === 0 && (
          <div className="window-empty" data-node="window/empty">
            {t("window.empty")}
          </div>
        )}
        {/* Every workspace is mounted to keep its session (an inactive one is hidden by visibility). */}
        <div className="terminal-stack">
          {workspaces.map((workspace) => (
            <WorkspacePlane
              key={workspace.id}
              workspace={workspace}
              isActiveWorkspace={workspace.id === activeId}
              sidebarW={sidebarW}
              rightW={rightW}
              rightMode={rightSidebarMode}
              contentTabPosition={contentTabPosition}
              startResize={startResize}
              startRightResize={startRightResize}
            />
          ))}
        </div>
      </div>
      {/* In-app notification banner (when focused) — the topmost overlay of the app root. */}
      <NotifyHost />
      {/* Webview recovery exhausted badge (non-blocking) — subscribes to core webview_health transitions. */}
      <WebviewHealthBadges />
      {/* Boot phase (restore, plugin prep) — a subtle progress mark before ready. */}
      <BootPhaseBadge />
    </div>
  );
}

export default App;
