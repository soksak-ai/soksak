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
import { addProjectClaimed, closeProjectReleased, useOtherWindowProjects } from "./state/projectRegistry";
import { removeRecentProject, useRecentProjects } from "./state/recentProjects";
import { rafThrottle } from "./lib/rafThrottle";
import { railEdgeWidths } from "./ui/railEdges";
import { parkedStyle } from "./lib/layerPark";
import { emitPluginEvent } from "./plugins/hooks";
import { resolveTerminalProgram } from "./plugins/terminalEngine";
import { startPointerOrderRepair } from "./lib/pointerOrderRepair";
import { isPrimaryModifier, routeZoom } from "./lib/zoomIntent";
import { beginLayoutMotion, endLayoutMotion } from "./lib/layoutMotion";
import { startViewFocusSync } from "./plugins/viewFocus";
import { bindPaneUnder } from "./lib/bindPaneUnder";
import { browserViewIdFromLabel } from "./lib/webviewLabels";
import {
  CONTENT_VIEW_EVENT,
  activatedLabelOf,
  relayFrameworkContentViewEvents,
} from "./lib/contentViewEvents";
import { LeftSidebarHost } from "./components/LeftSidebarHost";
import { RailGridSurface, type RailGridSurfaceHandle } from "./components/RailGridSurface";
import { useLayoutDecorationPresentation } from "./lib/layoutDecorationPresentation";
import { RailLinkOverlay } from "./components/RailLinkOverlay";
import { PluginSidebar } from "./components/PluginSidebar";
import { ContentTabs } from "./components/ContentTabs";
import { GroupArea, HEADER_PX, PANE_INSET } from "./components/GroupArea";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectSettingsModal } from "./components/ProjectSettingsModal";
import { Icon } from "./ui/icons/Icon";
import { validateProjectRoot } from "./lib/projectRoot";
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
  type Project,
  type Pane,
} from "./state/sessions";
import {
  useSettings,
  type TabPosition,
  type RightSidebarMode,
} from "./state/settings";
import { useTheme } from "./state/theme";
import { getPtyIo, hasPtyObservation } from "./terminal/ptyObservationStore";
import {
  DEFAULT_RAIL_PLACEMENT,
  railStationFromLeftPx,
  snapRailStation,
} from "./lib/railPlacement";
import { railGeometryScopeId, railPresentation } from "./lib/railMotion";
import { useAppChromeLayoutReflow } from "./lib/appChromeLayoutReflow";
import { useArrangementPhase } from "./components/useArrangementPhase";
import {
  arrangementMoves,
  resolvePresentedRailRelation,
  viewIdsOfMoves,
} from "./lib/railArrangement";
import { prepareLayoutChange, viewLayoutChange } from "./lib/layoutTransitionHost";
import { registerLayoutTransitionIntentHost } from "./lib/layoutTransitionIntent";
import { ownsNativeSurfaceFromManifests } from "./lib/nativeSurfaceOwnership";
import "./App.css";

// Make a file path safe for both the shell and Claude Code: backslash-escape everything except
// alphanumerics and safe characters (spaces included). The result ends with an unquoted extension
// such as ...img.png, which matches both Claude Code's image extension regex and the shell.
const shellEscape = (p: string) => p.replace(/[^A-Za-z0-9_./@%+:,=-]/g, "\\$&");

// Pass GroupArea only the public media facts the manifest owns. GroupArea does not read inside the
// framework or the plugin registry; it picks the travel visual owner from this identity set.
const nativeSurfaceViewIds = (content: Project["spaces"][number]): string[] => (
  allGroups(content.layout).flatMap((group) => group.tabs
    .filter((view) => view.kind === "plugin"
      && ownsNativeSurfaceFromManifests(view.pluginId, view.view))
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
// Left project rail width.
// Product layout contract: project rail default 54px, drag 44–110px.
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
  // begin is reference-stable (useCallback) — passing it as a prop into the memoized ProjectPlane
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

// Body of one project (left sidebar + content + right plugin sidebar).
// memo boundary = project data boundary (principle 2, docs/PERFORMANCE.md): a store write for project X
// preserves the object identity of project Y (mapProject), so the Y subtree does not re-render.
// Every prop must be reference- or value-stable — no custom comparator.
const ProjectPlane = memo(function ProjectPlane({
  project,
  isActiveProject,
  sidebarW,
  rightW,
  rightMode,
  contentTabPosition,
  startResize,
  startRightResize,
}: {
  project: Project;
  isActiveProject: boolean;
  sidebarW: number;
  rightW: number;
  rightMode: RightSidebarMode;
  contentTabPosition: TabPosition;
  startResize: (e: React.MouseEvent) => void;
  startRightResize: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const setLeftRailPlacement = useSessions((s) => s.setLeftRailPlacement);
  const railPlaneRef = useRef<HTMLDivElement>(null);
  const railGridSurfaceRef = useRef<RailGridSurfaceHandle>(null);
  const placement = project.leftRailPlacement ?? DEFAULT_RAIL_PLACEMENT;
  const activeContent =
    project.spaces.find((content) => content.id === project.activeSpaceId) ??
    project.spaces[0];
  const decoration = useLayoutDecorationPresentation(
    `${project.id}/${activeContent?.id ?? "none"}`,
  );
  // Fall back to the last settled value so station does not collapse to 0 on an unresolved focus render.
  const lastStationRef = useRef(0);
  // The solver solves the arrangement — single truth for station, layout, produced adjacency and move amounts (never recompute).
  // **Subscribe** to the attach mode and pass it down — reading it through getState skips the redraw when the setting changes.
  const railPullFocused = useSettings((s) => s.railPullFocused);
  const solved = projectArrangement(project, lastStationRef.current, railPullFocused);
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
          .filter((view) => view.id === group.activeTabId && view.kind === "plugin"
            && ownsNativeSurfaceFromManifests(view.pluginId, view.view))
          .map((view) => view.id),
      }));
      return prepareLayoutChange(viewLayoutChange(
        from,
        to,
        groups,
        hostWidth,
        project.sidebarOpen ? sidebarW : 0,
      ), signal);
    },
    [project.sidebarOpen, sidebarW],
  );
  useLayoutEffect(
    () => registerLayoutTransitionIntentHost<Pane>(project.id, {
      prepare: ({ from, to }, signal) => prepareArrangementTravel(from, to, signal),
    }),
    [project.id, prepareArrangementTravel],
  );
  const phase = useArrangementPhase(
    solved,
    railGeometryScope,
    contentKey,
    undefined,
    prepareArrangementTravel,
    project.id,
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
        railOpen: project.sidebarOpen,
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
  // A change the phase has not accepted yet — focus already changed, but the journey starts on the next commit.
  // If the standing rail commits the new projection during that one render, on the next commit that instance becomes
  // the departing slot and **closes while holding the new projection** (measured: the file tree closed in the slot
  // where favorites had been standing). The phase owns the display — content, like geometry, changes when the phase accepts it.
  const arrangementPending =
    !!solved &&
    !!phase.displayed &&
    arrangementMoves(phase.displayed, solved).length > 0;
  // The rail is one persistent DOM node. Settle the target position first, then rewind from the start point with the
  // same FLIP phase as tabs. Duplicating source/target remounts ProjectionSlots and plugin views and produces empty frames.
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
      project.id,
      placement.mode === "pin"
        ? { mode: "flow" }
        : { mode: "pin", station: effectiveStation },
    );
  }, [effectiveStation, placement.mode, project.id, setLeftRailPlacement]);

  const startRailStationDrag = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || !project.sidebarOpen) return;
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
        setLeftRailPlacement(project.id, { mode: "pin", station: next });
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
      project.id,
      project.sidebarOpen,
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
  useLayoutEffect(() => {
    emitPluginEvent("layout.reflow", { activeSpaceId: project.activeSpaceId });
  }, [
    contentKey,
    activeContent?.activePaneId,
    activeContent?.maximizedTabId,
    project.activeSpaceId,
    project.sidebarOpen,
    isActiveProject,
    renderedStation,
    railTraveling,
    sidebarW,
    contentTabPosition,
  ]);
  return (
    <div
      className="project-plane"
      // Anchor of address axiom A1 — the chrome nodes inside this plane exist once per project.
      // The address must include the project for rail/left to resolve to exactly one (collectExposed reads it).
      data-project-plane={project.id}
      data-project-active={isActiveProject ? "1" : undefined}
      // An inactive project is hidden by ordinary DOM visibility rather than unmounted. Visibility of surfaces outside
      // the document is the separate responsibility of the framework consuming the view.parked/content-view host contract.
      style={parkedStyle(isActiveProject)}
    >
      {/* The upper content tabs stay outside the rail; only the selected panel grid shares a coordinate system with the rail. */}
      <div
        className={`content${contentTabPosition === "left" ? " space-tabs-left" : ""}`}
      >
        {project.rootMissing && (
          <div className="root-missing-banner" data-node="banner/root-missing">
            {t("project.rootMissing", { root: project.root })}
          </div>
        )}
        <ContentTabs
          project={project}
          vertical={contentTabPosition === "left"}
        />
        <RailGridSurface
          ref={railGridSurfaceRef}
          traveling={railTraveling}
          starting={phase.starting}
          relationOverlay={
            decoration.relationOverlay === "present" && !phase.replacing && activeContent && effectiveRailRelation ? (
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
              {railTraveling || phase.replacing || decoration.railSurface !== "present"
                ? null
                : <div
                  key={rail.key}
                  className={`sidebar rail-${railLook}`}
                  data-wv-occlusion="rail"
                  data-node="rail/left"
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
                      left: `calc(${rail.station}% - ${(sidebarW * rail.station) / 100}px)`,
                      width: project.sidebarOpen ? sidebarW : 0,
                      borderLeftWidth: railEdgeWidths(
                        railLook,
                        project.sidebarOpen,
                        rail.station,
                        paneStyle,
                      ).left,
                      borderRightWidth: railEdgeWidths(
                        railLook,
                        project.sidebarOpen,
                        rail.station,
                        paneStyle,
                      ).right,
                    } as React.CSSProperties
                  }
                >
                  <LeftSidebarHost
                    project={project}
                    paneId={cwdTabOf(project) ?? ""}
                    commitProjection={!arrangementPending}
                  />
                  {project.sidebarOpen && (
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
                  {project.sidebarOpen && (
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
          {project.spaces.map((c) => {
            const isActiveContent = c.id === project.activeSpaceId;
            return (
              <div
                key={c.id}
                className="space-plane"
                // Inactive content keeps its DOM lifetime and box; only visibility is turned off.
                style={parkedStyle(isActiveContent)}
              >
                <GroupArea
                  content={c}
                  projectId={project.id}
                  nativeSurfaceViewIds={nativeSurfaceViewIds(c)}
                  surfaceActive={isActiveProject && isActiveContent}
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
                    isActiveContent && project.sidebarOpen ? sidebarW : 0
                  }
                />
              </div>
            );
          })}
        </RailGridSurface>
      </div>

      {/* Right plugin sidebar (⌥⌘B). Closed = width 0 (not unmounted — keep-alive). */}
      {project.rightOpen && (
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
        className={`sidebar-right${project.rightOpen ? " open" : ""}${rightMode === "push" ? " push" : ""}`}
        data-node="sidebar/right"
        data-wv-occlusion="sidebar-right"
        data-focus-lighting="exempt"
        style={{
          width: project.rightOpen ? rightW : 0,
          borderLeftWidth: project.rightOpen ? 1 : 0,
        }}
      >
        <PluginSidebar projectId={project.id} />
      </div>
    </div>
  );
});

// The terminal pane the project sidebar (file tree) follows (= the current cwd source). The pure resolver is
// sessions.cwdTabOf — here it is called with the PTY observation predicate (hasPtyObservation) injected.
// No core/plugin terminal distinction — any view driving the PTY substrate (one that has an observation) is followed.
const cwdTabOf = (project: Project): string | undefined =>
  resolveCwdTab(project, hasPtyObservation);

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
  const projects = useSessions((s) => s.projects);
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
            {t("webview.exhausted", { label: webviewDisplayName(label, projects) })}
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
  const projectTabPosition = useSettings((s) => s.projectTabPosition);
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
  // The active project/space/pane/tab chain and the real keyboard focus are one contract.
  // Do not autofocus on mount; pass only the latest active view intent to the provider.
  useEffect(() => startViewFocusSync(), []);
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
  // The fact that a content view took focus → point at the cell under it.
  //
  // **A click inside a guest never arrives at the host.** A content view is a separate process, so its mousedown does not
  // cross into this document — pressing the browser therefore did not move the binding (measured 2026-08-02).
  // The only fact the host receives then is that **that element took focus**.
  //
  // Do not borrow the OS (A27). The framework emits that fact under the contract's name, and whether it arrives by
  // coordinates or by this event, the **same function** (lib/bindPaneUnder) is called — split paths get fixed on one
  // side only and that divergence is silent. The coordinate path is wired by that framework itself
  // (its adapter's install) — what is here is the path shared by both frameworks.
  useEffect(() => {
    // Re-emit what the framework reported through its handle in the contract's shape — a contract written down
    // and called by nobody is the same as no contract.
    const offRelay = relayFrameworkContentViewEvents((name, cb) =>
      listenThisWindow<Record<string, unknown>>(name, (e) => cb(e.payload)),
    );
    const offViewFocus = listenThisWindow<{ id: number }>(CONTENT_VIEW_EVENT.activated, (e) => {
      // Turning the handle (webContents id) into the fact (the label) is the seam's job — the app uses labels only.
      const label = activatedLabelOf(e.payload?.id);
      const viewId = label ? browserViewIdFromLabel(label) : null;
      const slot = viewId
        ? document.querySelector<HTMLElement>(`[data-node="layout/tab/${viewId}"]`)
        : null;
      bindPaneUnder(slot);
    });
    return () => {
      offViewFocus();
      offRelay();
    };
  }, []);

  // The gutter highlight bar is not drawn here — a DOM highlight being covered by a surface is a matter for the
  // framework whose content is outside the document, and that framework subscribes to the hover state and draws it
  // its own way (its adapter's install). The core holds the hover fact alone (useGutterHover).

  // Minimal subscription principle (docs/PERFORMANCE.md 1): per-field and per-action selectors only — no bare hook.
  // A zustand action is a stable reference fixed at create(), so an action selector causes no re-render.
  const projects = useSessions((s) => s.projects);
  const activeId = useSessions((s) => s.activeId);
  const setActive = useSessions((s) => s.setActive);
  const toggleSidebar = useSessions((s) => s.toggleSidebar);
  const toggleRightSidebar = useSessions((s) => s.toggleRightSidebar);
  const addViewToGroup = useSessions((s) => s.addViewToGroup);
  const closeView = useSessions((s) => s.closeView);
  // Target project id for the project settings modal (name/color).
  const [projectSettingsFor, setProjectSettingsFor] = useState<string | null>(
    null,
  );
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const activeProject = projects.find((t) => t.id === activeId);

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
  // The project tab rail is app chrome outside ProjectSurface. A top↔left swap and a rail width change also alter the
  // inner content slot geometry, so that commit is declared as the shared reflow event.
  useAppChromeLayoutReflow(
    [projectTabPosition, railW].join(":"),
    activeProject?.activeSpaceId ?? null,
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
  const rightRect =
    activeProject?.rightOpen && rightSidebarMode !== "push" ? rightW : 0;
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
    const notify = () => emitPluginEvent("layout.reflow", { activeSpaceId: activeProject?.activeSpaceId ?? null });
    const raf = requestAnimationFrame(notify);
    // A window resize also moves the sidebar rect (right edge fixed, height) — notify again.
    const onWinResize = () => requestAnimationFrame(notify);
    window.addEventListener("resize", onWinResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onWinResize);
    };
    // rightRect is the single derivation of rightOpen and rightW — notify again when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightRect]);

  // The core does not own terminal theming or session disposal — the terminal plugin applies app theme tokens to its
  // own view's xterm theme and cleans up the PTY session itself on view unmount (PluginViewHost).

  // Keyboard shortcuts (capture phase → ahead of xterm). Relative to the active view of the active project.
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
      // ⌘N new window (independent workspace) — project-independent, so handled first.
      if (key === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        invoke("window_create").catch((err) => console.error("new window failed:", err));
        return;
      }
      const s = useSessions.getState();
      const project = s.projects.find((t) => t.id === s.activeId);
      if (!project) return;
      const content =
        project.spaces.find((c) => c.id === project.activeSpaceId) ??
        project.spaces[0];
      if (!content) return;
      // ⌥⌘B right plugin sidebar. With ⌥ the e.key is a composed character ("∫"), so the check uses e.code.
      if (e.altKey && !e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        toggleRightSidebar(project.id);
        return;
      }
      const groups = allGroups(content.layout);
      const grp =
        groups.find((g) => g.id === content.activePaneId) ?? groups[0];
      const view = grp?.tabs.find((v) => v.id === grp.activeTabId);
      if (key === "w" && !e.shiftKey) {
        // ⌘W closes the active view (core terminal pane splitting removed — view-level close only).
        e.preventDefault();
        if (view) closeView(project.id, view.id);
      } else if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        // ⌘T = new terminal tab. The core names no specific engine — it opens the configured terminal engine (contract resolution).
        // With no active terminal engine it opens nothing (no stray empty tabs — ⌘T means terminal only).
        const terminalProgram = resolveTerminalProgram();
        if (terminalProgram) addViewToGroup(project.id, terminalProgram);
      } else if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar(project.id);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeView, addViewToGroup, toggleSidebar, toggleRightSidebar]);

  // File drag and drop: injects escaped paths into the active project's terminal pane (plugin terminal, PTY substrate).
  // The core does not own the terminal host div, so it sends through the substrate IO (getPtyIo).
  useEffect(() => {
    const unlisten = currentWindow().onDragDrop((e) => {
      const event = e as { payload: { type: string; paths?: string[] } };
      if (event.payload.type !== "drop") return;
      const { paths } = event.payload;
      if (!paths || paths.length === 0) return;
      const s = useSessions.getState();
      const proj = s.projects.find((t) => t.id === s.activeId);
      const paneId = proj ? cwdTabOf(proj) : undefined;
      if (!paneId) return;
      getPtyIo(paneId)?.sendInput(paths.map(shellEscape).join(" "));
    });
    return () => {
      unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  // Project tab list (the same markup is reused for the horizontal top and vertical left placements).
  // Double click = project settings modal (name + identifying color — replaces inline rename).
  const projectTabsList = (
    <>
      {projects.map((proj) => (
        <div
          key={proj.id}
          className={`project-tab${proj.id === activeId ? " active" : ""}`}
          onClick={() => setActive(proj.id)}
          onDoubleClick={() => setProjectSettingsFor(proj.id)}
        >
          {proj.color && (
            <span className="project-tab-dot" style={{ background: proj.color }} />
          )}
          <span className="project-tab-title">{proj.title}</span>
          {projects.length > 1 && (
            <button
              type="button"
              className="icon-btn icon-btn--mini project-tab-close"
              title={t("project.close")}
              onClick={(e) => {
                e.stopPropagation();
                void closeProjectReleased(proj.id); // P6: a successful close releases the global claim
              }}
            >
              <Icon name="close" size="md" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="icon-btn project-tab-add"
        data-node="project/add"
        title={t("project.new")}
        onClick={() => setNewProjectOpen(true)}
      >
        <Icon name="add" />
      </button>
    </>
  );

  // Left rail: chip width tracks the rail width (adaptive). Labels ellipsize; shrunk to the minimum width (RAIL_MIN)
  // only the first character shows (no ellipsis). Double click = project settings (name/color), right click = close.
  const railAtMin = railW <= RAIL_MIN;
  const otherProjects = useOtherWindowProjects();
  const recentAll = useRecentProjects();
  // Recents open nowhere = all recents − this window's roots − other windows' roots.
  const openRoots = new Set([
    ...projects.map((p) => p.root),
    ...otherProjects.map((o) => o.root),
  ]);
  const recentClosed = recentAll.filter((r) => !openRoots.has(r.root));
  const projectRailList = (
    <>
      {projects.map((proj) => (
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
          onDoubleClick={() => setProjectSettingsFor(proj.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (projects.length > 1) void closeProjectReleased(proj.id); // P6 release included
          }}
        >
          <span className="rail-chip-label">
            {railAtMin ? ([...proj.title][0] ?? "") : proj.title}
          </span>
        </div>
      ))}
      {/* Projects of other windows (the global registry) — every project is listed in one list (after
          mine, before "+" — the user-fixed order s,p,+). Dotted and damped styles mark the distinction.
          Click = focus the owning window (P6: move instead of a duplicate open). */}
      {otherProjects.map((o) => {
        const name = o.root.split("/").filter(Boolean).pop() ?? o.root;
        return (
          <div
            key={o.root}
            className="rail-chip other"
            data-node={`rail/other/${name}`}
            title={t("project.otherWindow", { window: o.window, root: o.root })}
            onClick={() => void invoke("window_focus", { label: o.window })}
          >
            <span className="rail-chip-label">
              {railAtMin ? ([...name][0] ?? "") : name}
            </span>
          </div>
        );
      })}
      {/* Recent projects open in no window — offered as rail buttons.
          Click = open in this window (through the P6 gate). A lost root self-heals out of the list by removal. */}
      {recentClosed.map((r) => {
        const name = r.alias || (r.root.split("/").filter(Boolean).pop() ?? r.root);
        return (
          <div
            key={r.root}
            className="rail-chip recent"
            data-node={`rail/recent/${name}`}
            title={t("project.recentOpen", { root: r.root })}
            onClick={() => {
              void (async () => {
                try {
                  await validateProjectRoot(r.root);
                } catch {
                  console.warn(`recent project root missing — removed from the list: ${r.root}`);
                  void removeRecentProject(r.root);
                  return;
                }
                await addProjectClaimed({ root: r.root, alias: r.alias });
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
        title={t("project.new")}
        onClick={() => setNewProjectOpen(true)}
      >
        <Icon name="add" size="lg" />
      </button>
    </>
  );

  return (
    <div className="app-root">
      {/* Overlay titlebar: logo (fixed at the front) + project tabs. Dragging the empty area moves the window. */}
      <div className="titlebar" data-node="titlebar" {...dragRegion}>
        {/* The logo is fixed right after the traffic lights (82px) — tabs always stack after the logo.
            pointer-events:none keeps it from intercepting the window drag. */}
        <span
          className="titlebar-logo"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: logoRaw }}
        />
        {/* Build identity badge (DEV=HMR / DEBUG=debug bundle) — fixed right after the logo. Project
            tabs (top mode) stack after it. Release (soksak) has no badge. */}
        <BuildBadge />
        {projectTabPosition === "top" ? (
          <div className="project-tabs" {...dragRegion}>
            {projectTabsList}
          </div>
        ) : (
          /* Left mode: the titlebar has no tabs, only the drag region (tabs move to the left rail). */
          <div className="project-tabs" {...dragRegion} />
        )}
        <div className="titlebar-right">
          <PluginHeaderActions />
          <button
            type="button"
            className={`icon-btn sidebar-toggle${activeProject?.sidebarOpen ? " active" : ""}`}
            title={t("sidebar.toggle")}
            aria-label={t("sidebar.toggle")}
            onClick={() => activeProject && toggleSidebar(activeProject.id)}
          >
            <Icon name="panel-left" />
          </button>
          <button
            type="button"
            className={`icon-btn sidebar-toggle${activeProject?.rightOpen ? " active" : ""}`}
            title={t("plugin.sidebar.toggle")}
            aria-label={t("plugin.sidebar.toggle")}
            onClick={() =>
              activeProject && toggleRightSidebar(activeProject.id)
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
      {newProjectOpen && (
        <NewProjectModal onClose={() => setNewProjectOpen(false)} />
      )}
      {projectSettingsFor && (
        <ProjectSettingsModal
          projectId={projectSettingsFor}
          onClose={() => setProjectSettingsFor(null)}
        />
      )}
      <ConfirmCloseModal />
      <RemoteConfirmModal />
      <RecoverySetupModal />
      <RecoveryEnterModal />

      {/* Body: in left mode, a vertical project rail + the content row. */}
      <div className={`app-body${projectTabPosition === "left" ? " with-rail" : ""}`}>
        {projectTabPosition === "left" && (
          <>
            <div className="project-rail" style={{ width: railW }}>
              {projectRailList}
            </div>
            <div
              className="project-rail-resizer"
              onMouseDown={startRailResize}
              title={t("sidebar.resize")}
            />
          </>
        )}
        {/* Zero projects = an exception state only (P6 degradation, a restore drop) — open and create are
            control-plane surfaces. An empty workspace window has no create path (window.new requires root),
            so only the notice remains. */}
        {projects.length === 0 && (
          <div className="window-empty" data-node="window/empty">
            {t("window.empty")}
          </div>
        )}
        {/* Every project is mounted to keep its session (an inactive one is hidden by visibility). */}
        <div className="terminal-stack">
          {projects.map((project) => (
            <ProjectPlane
              key={project.id}
              project={project}
              isActiveProject={project.id === activeId}
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
