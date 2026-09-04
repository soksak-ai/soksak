import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { moduleState } from "../lib/moduleState";
import { coversBox } from "../lib/overlayCoverage";
import { execute } from "../commands/registry";
import { rafThrottle } from "../lib/rafThrottle";
import {
  commitViewPresentation,
  resolveViewVisibility,
  viewSurfacePlacementForPresentation,
  viewSurfaceStyle,
} from "../lib/viewPark";
import {
  onParkedPictureChange, parkedPicture, parkedPictureShown, parkedPictureVersion,
} from "../lib/parkedPicture";
import { Icon } from "../ui/icons/Icon";
import { GroupStatusBar } from "./GroupStatusBar";
import { PluginViewHost } from "./PluginViewHost";
import { armSlotActivation } from "../lib/slotGesture";
import { activatePaneIntent, activateTabIntent } from "../lib/viewActivation";
import { beginLayoutMotion, endLayoutMotion } from "../lib/layoutMotion";
import { CHROME_BANDS } from "../lib/chromeBands";
import { createRectMotionTracker } from "../lib/layoutRectMotion";
import { timed, useRenderCost } from "../lib/mainThreadCost";
import { recordRailPhase } from "../lib/railJournal";
import { useGutterHover } from "../state/gutterHover";
import { ViewTabs } from "./ViewTabs";
import { FocusLightingPlane } from "./FocusLightingPlane";
import { ParkedPicture } from "./ParkedPicture";
import { railLightingExemption } from "./focusLightingGeometry";
import { layoutGeometrySignature } from "../lib/layoutGeometrySignature";
import { useLayoutGeometryReflow } from "../lib/layoutGeometryReflow";
import { gutterAddress, gutterOwnerOf } from "../lib/gutterAddress";
import { boundaryShares } from "../state/panePlane";
import { beginGesture } from "../lib/gesture";
import { commitDomLayout } from "../lib/domLayoutCommit";
import { listenThisWindow } from "../lib/windowEvents";
import type { NativePointerEdge } from "../lib/windowPointerActivation";
import { useT } from "../i18n";
import { useTheme } from "../state/theme";
import { useSettings } from "../state/settings";
import { dimAmount, dimLevel } from "../lib/dimLevel";
import { useUi } from "../state/ui";
import {
  type Space,
  type DropZone,
  type Tab,
  type Pane,
  allGroups,
  useSessions,
  viewDisplayTitle,
} from "../state/sessions";
import { useHydration } from "../state/hydration";
import type { Arrangement, ArrangementMove, Rect } from "../lib/railArrangement";
import { moveBoundaryPx, rectsOf, zoneAt, type Divider } from "../state/panePlane";
import { usePlaneBox } from "../state/planeBox";
import { viewTravelPresentation } from "../lib/viewTravelPresentation";
import { roundedOrthogonalPath } from "../lib/railLinkShape";
import {
  cssColorRGBA,
  replaceNativeDecorations,
  strokeDecoration,
} from "../lib/nativeDecorations";
import { dividerSurfaceGeometry } from "../lib/dividerSurfaceGeometry";
import { stageNativeSurfaceGeometry } from "../framework/wails/nativeSurfaces";
import { createDividerResizeTransaction } from "../lib/dividerResizeTransaction";
import { afterFramePaint } from "../lib/afterFramePaint";
import { appliedResizeSizes, beginResizeGesture, computedResizeSizes, endResizeGesture, moveResizeGesture } from "../lib/resizeGestureFacts";

// Render the content area as editor groups. Two core principles:
// 1) Keep the body (terminal/editor) separate from the group tree structure, in a "persistent body layer" keyed
//    by viewId → split, move and resize change the tree with no remount (session and editor fully preserved).
// 2) Dragging uses pointer events (mousedown/move/up), not HTML5 DnD — it does not collide with Tauri native
//    file drag-drop (that path is for external files only), it actually works, and we fully control the drop
//    zones and indicators.
//
// Each group = [title bar (drag = move group)] [tab bar (tab drag = move view)] [body] [status bar].

export type { Rect };
export interface Cell {
  group: Pane;
  /** The pane's rect on the plane, in px from the plane's origin. */
  rect: Rect;
}

// 33 = padding 4 + chip 24 + padding 4 + divider 1 — the interior (32) is even, so the chip is even too and
// even-sized chip content (icon 12/14, close 16) centers on whole pixels (no half pixels).
// The rail (App.tsx) consumes the same row contract — this module is the sole owner of the pane grid row dimensions.
// lib/chromeBands owns the band heights — the sidebar and the content use the same values.
export const HEADER_PX = CHROME_BANDS.header;
const STATUS_PX = CHROME_BANDS.footer;
const CHROME_TOP = HEADER_PX; // Body top offset
const DRAG_THRESHOLD = 5; // Movement past this many pixels counts as a drag (otherwise a click)

// Panel gap per paneStyle token (half value — 10/12px summed between neighbours, the reference divider's real width).
// The plane's corridor (split-pane `gap`) is twice this, and the plane is the host inset by it.
export const PANE_INSET: Record<string, number> = { flat: 0, card: 5, floating: 6 };

function cornerFocusPath(rect: DOMRect, strokeWidth: number): string {
  const half = strokeWidth / 2;
  const left = rect.left + half;
  const right = rect.right - half;
  // getBoundingClientRect() is already in viewport coordinates. Header/status
  // offsets belong to layout projection, not to the measured decoration rect.
  // Applying them here double-shifts the native corners outside their pane.
  const top = rect.top + half;
  const bottom = rect.bottom - half;
  const arm = 14;
  return [
    `M ${left} ${top} L ${left + arm} ${top}`,
    `M ${right - arm} ${top} L ${right} ${top}`,
    `M ${left} ${bottom} L ${left + arm} ${bottom}`,
    `M ${right - arm} ${bottom} L ${right} ${bottom}`,
    `M ${left} ${top} L ${left} ${top + arm}`,
    `M ${left} ${bottom - arm} L ${left} ${bottom}`,
    `M ${right} ${top} L ${right} ${top + arm}`,
    `M ${right} ${bottom - arm} L ${right} ${bottom}`,
  ].join(" ");
}

export function NativeFocusBoundary({
  owner,
  node,
  style,
  trackRef,
  active,
}: {
  owner: string;
  node: string;
  style: CSSProperties;
  trackRef: (element: HTMLElement | null) => void;
  active: boolean;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const focusIndicator = useSettings((state) => state.focusIndicator);
  const accent = useTheme((state) => state.colors.acc);
  const attach = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
    trackRef(element);
  }, [trackRef]);
  const update = useCallback(() => {
    const element = elementRef.current;
    const color = cssColorRGBA(accent);
    if (!active || !element || !color) {
      replaceNativeDecorations(owner, []);
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      replaceNativeDecorations(owner, []);
      return;
    }
    const strokeWidth = 1;
    let path: string;
    if (focusIndicator === "corners") {
      path = cornerFocusPath(rect, strokeWidth);
    } else {
      const half = strokeWidth / 2;
      const points = [
        { x: rect.left + half, y: rect.top + half },
        { x: rect.right - half, y: rect.top + half },
        { x: rect.right - half, y: rect.bottom - half },
        { x: rect.left + half, y: rect.bottom - half },
      ];
      const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
      path = roundedOrthogonalPath(points, radius);
    }
    replaceNativeDecorations(owner, [
      strokeDecoration(`${owner}/stroke`, path, color, strokeWidth),
    ]);
  }, [accent, active, focusIndicator, owner]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!active || !element) return () => replaceNativeDecorations(owner, []);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      replaceNativeDecorations(owner, []);
    };
  }, [active, owner, update]);

  // Position-only layout commits do not notify ResizeObserver. Project on every React geometry
  // commit before paint as well; unchanged snapshots are deduplicated by nativeDecorations.
  // The observer above remains the event source for external size changes that do not render Core.
  useLayoutEffect(() => update());

  return (
    <div
      ref={attach}
      className="pane-focus-boundary"
      data-node={node}
      data-native-decoration={active ? "focus-boundary" : undefined}
      style={style}
    />
  );
}

/**
 * Structural pane frame. A DOM border cannot be painted above an opaque native child webview;
 * the visible stroke therefore is emitted on the same native decoration plane as the focus frame.
 * The DOM element remains as the document-side frame for non-native content and as the measured
 * geometry owner, while this component publishes the identical rectangle to the native layer.
 */
export function NativePaneBorder({
  owner,
  node,
  style,
  trackRef,
  active,
}: {
  owner: string;
  node: string;
  style: CSSProperties;
  trackRef: (element: HTMLElement | null) => void;
  active: boolean;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const border = useTheme((state) => state.colors.bd);
  const attach = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
    trackRef(element);
  }, [trackRef]);
  const update = useCallback(() => {
    const element = elementRef.current;
    const color = cssColorRGBA(border);
    if (!active || !element || !color) {
      replaceNativeDecorations(owner, []);
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      replaceNativeDecorations(owner, []);
      return;
    }
    const strokeWidth = 1;
    const half = strokeWidth / 2;
    const points = [
      { x: rect.left + half, y: rect.top + half },
      { x: rect.right - half, y: rect.top + half },
      { x: rect.right - half, y: rect.bottom - half },
      { x: rect.left + half, y: rect.bottom - half },
    ];
    const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
    replaceNativeDecorations(owner, [
      strokeDecoration(`${owner}/stroke`, roundedOrthogonalPath(points, radius), color, strokeWidth),
    ]);
  }, [active, border, owner]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!active || !element) return () => replaceNativeDecorations(owner, []);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      replaceNativeDecorations(owner, []);
    };
  }, [active, owner, update]);
  useLayoutEffect(() => update());

  return (
    <div
      ref={attach}
      className="pane-border"
      data-node={node}
      data-native-decoration={active ? "pane-border" : undefined}
      style={style}
    />
  );
}

const titleOf = (v: Tab | undefined): string => (v ? viewDisplayTitle(v) : "");

// Guard against a duplicate start of a divider resize drag. When the divider is over a gap with no native child, both
// the real DOM mousedown and the synthetic mousedown replayed by the core native-mouse bridge (App.tsx) can arrive —
// only the first one owns the drag and the rest are ignored (prevents double window listener registration). One divider drag at a time.
// Outside the hot-swap boundary — a fresh value drops both the "already done" memory and the lazy initialization,
// and the filler does not fill again.
const ms = moduleState("components/GroupArea.#state", () => ({
  resizeDragActive: false,
}));
// Report the divider drag gesture fact to both consumers of the common layout phase:
// (1) plugins receive layout.resize-gesture so they can coalesce provider-owned rendering work;
// (2) a framework with out-of-document surfaces marks every geometry snapshot interactive while continuing to
//     apply each preview rectangle. Interactive is not permission to hold native bounds until release.
// Called only behind the ms.resizeDragActive guard, so start and end always pair.
function emitResizeGesture(active: boolean): void {
  // Delegated to the single truth layoutMotion — edge pairing holds even when drag, travel and FLIP overlap.
  if (active) beginLayoutMotion("resize");
  else endLayoutMotion("resize");
}

// Stable gutter key (for hover highlight matching) = that gutter's canonical address. App looks up the element rect by
// this key and passes it to the core to draw the native highlight bar over the browser (the seam=child bite approach
// was dropped for pushing and reflow). Why the key is the address: writing the internal split id into the DOM sends
// something unnamed outside (IDENTITY §4), and that value is void after a restart, so a script has nothing to hold.
// The canonical address is neither of those.

// memo boundary = content data boundary (principle 2): a store write for content X preserves the object identity of
// content Y (mapContent), so the GroupArea of another content or workspace is skipped.
export function isViewContentVisible(
  surfaceActive: boolean,
  maximizedId: string | null,
  viewId: string,
  activeTabId: string,
): boolean {
  const tabActive = maximizedId ? viewId === maximizedId : viewId === activeTabId;
  return resolveViewVisibility(surfaceActive, true, tabActive, false, false).contentVisible;
}

export const GroupArea = memo(function GroupArea({
  content,
  projectId,
  arrangement,
  focusedPaneId,
  surfaceActive = true,
  betweenIds,
  moves,
  travelFrom,
  replaceGeometry = false,
  nativeSurfaceViewIds = [],
}: {
  content: Space;
  projectId: string;
  /**
   * The solution this render **draws** — cells, dividers, the rail and the maximize fact, from one
   * solve. Never the raw state: station and rects are decided together, and a maximize flag from
   * another moment puts a new rect on an old line (measured 2026-07-29: maximizing the browser in a
   * half-and-half split took exposed nodes from 64 to 0 and blanked the window).
   */
  arrangement: Arrangement;
  /** Focused panel of the solution the screen draws — dimming follows the same solution as geometry (omitted = canonical active). */
  focusedPaneId?: string | null;
  /** Whether this space (content) is active — used to resolve effective view visibility (space && tab). */
  // Whether the surface holding this group (workspace + space) is on screen now — the two upper layers of view visibility.
  surfaceActive?: boolean;
  /** Move amounts the solution named — present only during a phase. A panel absent here does not move. */
  /** Cells wedged between the rail and the focused panel — they do not move but are blocked, so they dim. */
  betweenIds?: string[];
  moves?: ArrangementMove[];
  /** The solution the phase departs from. A divider's travel is read against it — it must arrive with
   *  moves in the same phase (with only one, cells glide while the corridor teleports and the screen tears). */
  travelFrom?: Arrangement;
  /** Target DOM commit of a structural snap. Replaces with the new structure instead of FLIPping the old rect to the target. */
  replaceGeometry?: boolean;
  /** Out-of-document surface view identities the manifest declared. The boundary above finishes any framework-internal lookup. */
  nativeSurfaceViewIds?: readonly string[];
}) {
  // A native surface is composited above the document, so no z-index puts it under a modal. The
  // count of open overlays is the fourth layer of `surfaceShown` — nothing read this counter until
  // 2026-08-17, and the plugin manager opened with two browser pages drawn over its card.
  // Which panes an open overlay covers. Only those step aside: the swap between a surface and its
  // picture crosses two compositing layers and cannot land in one frame, so a pane nothing is drawn
  // over stays exactly as it is (measured 2026-09-04: a dropdown over 31px of one pane made every
  // pane in the window flash).
  const nativeOverlayAreas = useUi((s) => s.nativeOverlayAreas);
  const [coveredPanes, setCoveredPanes] = useState<ReadonlySet<string>>(() => new Set());
  useLayoutEffect(() => {
    if (nativeOverlayAreas.length === 0) {
      setCoveredPanes((held) => (held.size === 0 ? held : new Set()));
      return;
    }
    // Measured on the overlay's own state edge, not on a render or a clock.
    const covered = new Set<string>();
    for (const node of document.querySelectorAll<HTMLElement>('[data-node^="layout/pane/"]')) {
      const id = node.dataset.node?.slice("layout/pane/".length);
      if (!id) continue;
      const box = node.getBoundingClientRect();
      if (coversBox(nativeOverlayAreas, {
        left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      })) covered.add(id);
    }
    setCoveredPanes(covered);
  }, [nativeOverlayAreas]);
  const overlayedPane = (paneId: string) => coveredPanes.has(paneId);
  // One inventory subscription, not one hook per tab. A successful capture advances the revision;
  // this render then changes the declaration from live to parked. Until publication the surface stays
  // applied, so render cannot hide the surface before capture completes.
  useSyncExternalStore(onParkedPictureChange, parkedPictureVersion, parkedPictureVersion);
  const t = useT();
  // JS interpolation (FLIP) of command-driven rect changes — on every commit flush compares against the previous rect (layoutRectMotion).
  useRenderCost("render.panes");
  // A page moves with its pane, every frame of the way.
  //
  // The declaration follows its element every frame and the native layer holds what it was given —
  // measured 2026-08-17, zero on both, over all six ways focus can move — so a page travelling with
  // its pane is what this build does and what a person sees. A motion is not a reason to take it off
  // the screen: parked for the length of one, a page holds two positions, the one it started at and
  // the one it ended at, and what travelled was a picture.
  //
  // What no motion can fix is the order. A surface is composited above the document, so a card drawn
  // over a pane is drawn under the page in it — and there the page does step aside, and its picture,
  // which is in the document, stands in its place. That is the overlay term of the presentation.
  const rectMotion = useRef(createRectMotionTracker(`${projectId}/${content.id}`)).current;
  // A divider preview owns immediate geometry. This marker travels with the state write until the
  // corresponding React layout commit consumes it; the native input callback may already have ended
  // by then, especially when the window is not focused and React batches the external event.
  const resizeGeometryPending = useRef(false);
  const displayLayout = arrangement.display;
  const focusProjectionApplied = arrangement.swapped;
  const traveling = (moves?.length ?? 0) > 0;
  const moveOf = (groupId?: string) =>
    groupId ? moves?.find((move) => move.id === groupId) : undefined;
  const nativeSurfaceViews = new Set(nativeSurfaceViewIds);
  const presentationOf = (group: Pane, viewId = group.activeTabId) => viewTravelPresentation({
    traveling,
    moving: flipMoves(group.id),
    nativeSurface: nativeSurfaceViews.has(viewId),
  });
  // B4 — subscribe to the restore hydration cold set (normally empty → no re-render).
  const coldSet = useHydration((s) => s.cold);
  // Promote a visible cold view at once (no set during render — effect). Same rule as the shown decision.
  useEffect(() => {
    if (coldSet.size === 0) return;
    const maximizedId2 = content.maximizedTabId ?? null;
    for (const g of allGroups(content)) {
      const visibleId = maximizedId2 ?? g.activeTabId;
      if (coldSet.has(visibleId)) useHydration.getState().promote(visibleId);
    }
  }, [coldSet, content]);
  // Split panel header = fixed to tab mode (2026-06 decision — not exposed in settings). The title mode branch is
  // kept in case it is exposed again: to restore it, switch back to useSettings((s) => s.splitHeaderMode).
  const splitHeaderMode = "tabs" as "title" | "tabs";
  // Consume the structure token: panel gap per paneStyle (card and floating use a real-width divider).
  const paneStyle = useTheme((s) => s.spec.chrome.paneStyle);
  // Focus spotlight experiment — sink everything and keep only the selection clear (remove once decided).
  const focusDim = useSettings((s) => s.focusDim);
  const inset = PANE_INSET[paneStyle] ?? 0;

  // Dim strength — the user sets it. The value goes down to the surface, so CSS writes no number.
  const dimIdle = useSettings((s) => s.dimIdle);
  const dimBlocked = useSettings((s) => s.dimBlocked);

  // Dimming is one level — the cell (.pane) and the slot (.tab-body) come from different traversals but must read
  // the same value. Recombining the reasons separately makes the two surfaces diverge silently (one fact, one place).
  // Emit the name (why it dims) and the strength (how much) together — both must be decided here or the media diverge.
  // The strength one cell is dimmed by. Three readers: the cell, the slot, and the surface the slot
  // holds — the veil is an SVG over the document and cannot darken a surface composited above it,
  // so the surface applies the same number to its own alpha.
  const dimStrengthOf = (groupId: string) =>
    dimAmount(
      dimLevel({
        // **Dimming follows the solution the screen draws too.** Focus changes on click, but geometry changes when the
        // phase accepts it. If only dimming changes at once, the slot's level differs at the moment the journey starts
        // and the frozen snapshot baked then (it contains the veil) becomes unusable — nothing covers the surface for
        // the whole glide and the hole shows the background (measured 2026-08-02: at the swap peak two browsers went entirely blank).
        active: groupId === (focusedPaneId ?? content.activePaneId),
        focusDim,
        blocked: !!betweenIds?.includes(groupId),
      }),
      { idle: dimIdle, blocked: dimBlocked },
    );

  const dimOf = (groupId: string) => ({
    "data-dim": dimLevel({
      active: groupId === (focusedPaneId ?? content.activePaneId),
      focusDim,
      blocked: !!betweenIds?.includes(groupId),
    }),
    style: { "--dim": dimStrengthOf(groupId) },
  });

  // Click = active + real focus, one invariant. Relying on the state-change effect alone makes re-clicking an
  // already active group or pane a no-op, leaving only the mousedown default (a click on a non-focusable target
  // → blur), so focus falls back to body, and after that clicking the group again cannot recover it (the accident
  // felt right after a split: the marker attaches but input goes nowhere). So a body, tab or title click always
  // puts real focus on that group's focused pane, regardless of state.
  // Focus inside a view (terminal etc.) is handled by the plugin view itself on mount or activation — the core
  // only activates the group (the core no longer owns the terminal host div).
  const moveBoundary = useSessions((s) => s.moveBoundary);
  const pushOverlay = useUi((s) => s.pushOverlay);
  const popOverlay = useUi((s) => s.popOverlay);
  // Workspace root passed to the plugin view (content placement) host.
  const workspaceRoot = useSessions(
    (s) => s.workspaces.find((x) => x.id === projectId)?.root ?? null,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ kind: "view" | "group"; id: string } | null>(
    null,
  );
  const [hover, setHover] = useState<{ groupId: string; zone: DropZone } | null>(
    null,
  );

  // The plane every space is laid out in, and the geometry this render draws — both from the
  // library, through the arrangement. Nothing here computes a rect.
  const planeBox = usePlaneBox((s) => ({ width: s.width, height: s.height, gap: s.gap }));
  const panesById = useMemo(() => new Map(content.panes.map((g) => [g.id, g])), [content.panes]);
  const cells: Cell[] = useMemo(
    () => arrangement.cells.flatMap((cell) => {
      const group = panesById.get(cell.id);
      return group ? [{ group, rect: cell.rect }] : [];
    }),
    [arrangement.cells, panesById],
  );
  const gutters = arrangement.dividers;
  // Maximize (maximizedTabId): one tab takes the whole space. The plane is unchanged — the
  // solution draws that one pane alone, and the slots of the remaining panes stay hidden (session
  // preservation: terminal and webview mounts are never broken).
  // This state is the sole owner of the highlight (replaces divider :hover) — selector subscription (principle 1).
  const gutterHoverKey = useGutterHover((s) => s.key);
  // What the solution states is the truth (see the prop preamble above).
  const maximizedId = arrangement.maximizedId ? (content.maximizedTabId ?? null) : null;
  const maxCell = maximizedId
    ? (cells.find((c) => c.group.tabs.some((v) => v.id === maximizedId)) ?? null)
    : null;
  const displayCells = cells;
  // A pane hidden by the maximize keeps the rect it has on the space's own plane, so nothing
  // reflows when it comes back.
  const hiddenRects = useMemo(
    () => (maxCell ? rectsOf(content.layout, planeBox) : null),
    [maxCell, content.layout, planeBox],
  );
  const slotRectOf = (groupId: string): Rect => {
    const shown = cells.find((c) => c.group.id === groupId);
    if (shown) return shown.rect;
    const hidden = hiddenRects?.get(groupId);
    return hidden
      ? { left: hidden.x, top: hidden.y, width: hidden.w, height: hidden.h }
      : { left: 0, top: 0, width: 0, height: 0 };
  };
  // One record per phase, written after the commit so the rail surface count is what the document
  // holds rather than what this render intended. The three rail claims — the surface gone during a
  // transition and back exactly once after, a PIN click moving nothing, a FLOW station on the
  // focused pane's left clean line — are about moments, and a command asked afterwards sees only
  // the last one.
  // What a rect is made of. Anything missing here is a change that moves an element and skips its
  // motion; anything extra is a render that ends one that was playing.
  const geometrySignature = layoutGeometrySignature({
    traveling,
    railStation: arrangement.station,
    railWidthPx: arrangement.rail?.width ?? 0,
    paneInset: inset,
    replaceGeometry,
    cells: displayCells.map((c) => ({ id: c.group.id, rect: c.rect })),
    slotIds: displayCells.flatMap((c) => c.group.tabs.map((v) => v.id)),
  });
  useLayoutGeometryReflow(geometrySignature, content.id);
  // Once per layout commit, which is the tracker's contract. Running it on every render cancelled
  // every interpolation before it played — measured 2026-08-17, `ui.motion` held 64 journeys and
  // not one finished, so a pane, a tab and the surface under it jumped to their destination.
  useLayoutEffect(() => {
    timed("panes.flush", () => {
      rectMotion.flush(replaceGeometry || resizeGeometryPending.current ? "replace" : "animate");
      resizeGeometryPending.current = false;
    });
    // The signature is the whole dependency: every field in it is one the tracker reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometrySignature]);

  const phaseKey = [
    traveling ? "traveling" : "settled",
    arrangement.station,
    displayCells.map((c) => `${c.group.id}:${c.rect.left},${c.rect.top},${c.rect.width},${c.rect.height}`).join("|"),
  ].join("\u0000");
  useEffect(() => {
    recordRailPhase({
      phase: traveling ? "traveling" : "settled",
      station: arrangement.station,
      cleanLines: arrangement.cleanLines,
      cells: displayCells.map((c) => ({ id: c.group.id, rect: c.rect })),
    });
    // phaseKey collapses the arrangement into one string: a record per render would write the same
    // phase many times and the deltas between them would all be zero.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseKey]);

  // Ref that lets the drag callbacks stay reference-stable (useCallback) while reading the latest cells.
  // (A closure capturing cells directly makes a new function each render → the memo boundary breaks.)
  // Commit effective view visibility (surface active && tab active) — solely owned by the core (lib/viewPark.surfaceShown).
  // It runs after the render commit (effect), when the parking style is already applied, and commit is idempotent, so cost is paid only on change.
  useEffect(() => {
    for (const group of content.panes) {
      for (const v of group.tabs) {
        const tabActive = maxCell ? v.id === maximizedId : v.id === group.activeTabId;
        commitViewPresentation(
          v.id,
          resolveViewVisibility(surfaceActive, true, tabActive, overlayedPane(group.id), traveling),
        );
      }
    }
  });

  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const displayRef = useRef(displayLayout);
  displayRef.current = displayLayout;
  const planeBoxRef = useRef(planeBox);
  planeBoxRef.current = planeBox;

  // Pointer coordinates → which zone of which pane. The title, tab and status areas are centre
  // (move); the outer ¼ of the body is a split in that direction. The plane answers (zoneAt); the
  // pointer is taken to the plane's origin, which is the container inset by the pane inset.
  // r is the container rect captured once at drag start — the layout is static during a tab drag, so
  // getBoundingClientRect (forced layout) is not re-read on every tick (principle 5).
  const hitTest = useCallback(
    (
      clientX: number,
      clientY: number,
      r: DOMRect,
      sourceGroupId?: string,
      selfCenterOnly = true,
    ): { groupId: string; zone: DropZone } | null => {
      const hit = zoneAt(
        displayRef.current,
        planeBoxRef.current,
        clientX - r.left - inset,
        clientY - r.top - inset,
        {
          headerPx: CHROME_TOP,
          footerPx: STATUS_PX,
          centreOnly: selfCenterOnly ? sourceGroupId : undefined,
        },
      );
      if (!hit) return null;
      return { groupId: hit.id, zone: hit.zone === "centre" ? "center" : hit.zone };
    },
    [inset],
  );

  // Pointer drag start (title bar = group, tab = view). Past the threshold it is a drag, otherwise a click (switch).
  // Reference-stable (useCallback) — passing it into the memoized ViewTabs does not break the boundary.
  const startDrag = useCallback(
    (kind: "view" | "group", id: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // Block selection at mousedown so a tab or group drag does not paint the editor (.cm-content) or the
      // terminal body with a native selection — changing user-select afterwards cannot stop a selection that
      // already started (see the App.css .app-root comment). A click (tab switch) is handled on mouseup, so it
      // is unaffected.
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const cells = cellsRef.current;
      // Drag source group (for the self-area check): group = that group, view = the group containing that view.
      const sourceGroup =
        kind === "group"
          ? cells.find((c) => c.group.id === id)?.group
          : cells.find((c) => c.group.tabs.some((v) => v.id === id))?.group;
      const sourceGroupId = sourceGroup?.id;
      // Only a tab drag from a multi-view group may split at its own area's edge (tab detach).
      const selfCenterOnly =
        kind === "group" || !sourceGroup || sourceGroup.tabs.length <= 1;
      let moved = false;
      let rect: DOMRect | null = null;
      // Hover updates once per frame (principle 4), and the same {group, zone} keeps the state so a re-render
      // happens only when a zone boundary is crossed (otherwise every mousemove re-renders the whole subtree).
      const updateHover = rafThrottle((x: number, y: number) => {
        const next = rect ? hitTest(x, y, rect, sourceGroupId, selfCenterOnly) : null;
        setHover((prev) =>
          prev?.groupId === next?.groupId && prev?.zone === next?.zone
            ? prev
            : next,
        );
      });
      const onMove = (ev: MouseEvent) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD)
            return;
          moved = true;
          rect = containerRef.current?.getBoundingClientRect() ?? null;
          setDrag({ kind, id });
          // Drag = overlay (the drop indicator is drawn over the browser hole too).
          pushOverlay();
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        }
        updateHover(ev.clientX, ev.clientY);
      };
      const onUp = (ev: MouseEvent) => {
        updateHover.cancel(); // The drop decision is made directly below — the pending one is discarded.
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (moved) {
          popOverlay();
          const target = rect
            ? hitTest(ev.clientX, ev.clientY, rect, sourceGroupId, selfCenterOnly)
            : null;
          if (target) {
            // Drop = activate (the store makes the destination cell the activePaneId) — activation cannot be
            // separated from real focus (the same invariant as the click branch). A split drop creates a new
            // group, so focus goes to the resulting groupId.
            if (kind === "view")
              void execute("tab.move", { tab: id, dst: target.groupId, zone: target.zone }, {});
            else void execute("pane.move", { workspace: projectId, src: id, dst: target.groupId, zone: target.zone }, {});
          }
        } else if (kind === "view") {
          activateTabIntent(id); // Click = tab switch + real focus
        } else {
          activatePaneIntent(id);
        }
        setDrag(null);
        setHover(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [
      projectId,
      hitTest,
      pushOverlay,
      popOverlay,
    ],
  );

  // Stable callback for the memoized ViewTabs.
  const onTabPointerDown = useCallback(
    (viewId: string, e: React.MouseEvent) => startDrag("view", viewId)(e),
    [startDrag],
  );

  // Double click = centre the boundary between its two neighbours, through a command that names the
  // gutter by its address (the line index never leaves, IDENTITY §4).
  const onGutterDoubleClick = (d: Divider) => () => {
    const owner = gutterOwnerOf(displayLayout, d.axis, d.line);
    if (owner) {
      void execute("pane.equalize", { pane: owner.pane, edge: owner.side }, {});
    }
  };

  const onGutterDown = (d: Divider) => (e: React.MouseEvent) => {
    e.preventDefault();
    // Pair presentation and behavior in one place — preview runs every frame (one boundary, one
    // commit), commit runs once on landing (through a command). Forcing the pair makes "the screen
    // changed but the ledger has nothing" structurally impossible.
    const gesture = beginGesture<number>({
      preview: (px) => commitResize(px),
      commit: (px) => {
        // Name the gutter by its address — the line index never leaves (IDENTITY §4). The ratio
        // is the slot before the boundary over the two slots that meet there, from where the
        // plane put the line.
        const owner = gutterOwnerOf(displayLayout, d.axis, d.line);
        const landed = moveBoundaryPx(displayLayout, planeBoxRef.current, d.axis, d.line, px);
        if (owner && landed) {
          const [before, after] = boundaryShares(landed, d.axis, d.line);
          void execute(
            "pane.resize",
            { pane: owner.pane, edge: owner.side, ratio: before / (before + after) },
            {},
          );
        }
      },
    });
    if (ms.resizeDragActive) return; // A duplicate start (DOM + native composition) is ignored.
    const cont = containerRef.current;
    if (!cont) return;
    ms.resizeDragActive = true; // Only after the real drag start is confirmed (the early-return above does not lock).
    beginResizeGesture(gutterKey(d) ?? d.key, e.clientX, e.clientY);
    emitResizeGesture(true);
    const startPos = d.axis === "x" ? e.clientX : e.clientY;
    // The boundary's own px position at the start; the pointer's delta is added to it. The plane
    // keeps every pane at its floor (split-pane minSize), so no clamp is computed here.
    const startLine = d.axis === "x" ? d.x + d.w / 2 : d.y + d.h / 2;
    // Store commits are capped at once per frame (principles 3 and 4) — mousemove exceeds 60Hz.
    const resizeTransaction = createDividerResizeTransaction<number>({
      beforeStage: afterFramePaint,
      stage: async (px) => {
        const target = moveBoundaryPx(displayLayout, planeBoxRef.current, d.axis, d.line, px);
        if (!target) return;
        const rects = rectsOf(target, planeBoxRef.current);
        const targetCells = cellsRef.current.map((cell) => {
          const r = rects.get(cell.group.id);
          return {
            id: cell.group.id,
            rect: r ? { left: r.x, top: r.y, width: r.w, height: r.h } : cell.rect,
          };
        });
        const frames = dividerSurfaceGeometry(cont, targetCells);
        if (frames.size > 0) await stageNativeSurfaceGeometry(frames);
      },
      apply: (px) => commitDomLayout(() => {
        appliedResizeSizes([px]);
        resizeGeometryPending.current = true;
        moveBoundary(projectId, content.id, { axis: d.axis, line: d.line }, { px });
      }),
    });
    const commitResize = rafThrottle((px: number) => resizeTransaction.submit(px));
    const onMove = (ev: Pick<MouseEvent, "clientX" | "clientY">) => {
      moveResizeGesture(ev.clientX, ev.clientY);
      const px = startLine + ((d.axis === "x" ? ev.clientX : ev.clientY) - startPos);
      computedResizeSizes([px]);
      gesture.move(px);
    };
    let ended = false;
    let stopNativeInput = () => {};
    const onUp = async () => {
      if (ended) return;
      ended = true;
      endResizeGesture();
      // Settle not only the store's final position but the React DOM that consumed it. Emitting the end right after a
      // plain rafThrottle.flush makes the native consumer read the departure slot rect while the DOM widens only on
      // the next commit, leaving a black gap on the release frame. This contract is the meaning of the end event.
      // The landing command is part of the same geometry transaction as the last preview. React batches
      // external event updates, so issuing it after flushSync lets the resize phase close before the command's
      // render and turns the landing into an ordinary FLIP. Commit both writes while resize motion still owns
      // immediate geometry.
      commitResize.flush();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp as unknown as EventListener);
      stopNativeInput();
      document.body.style.cursor = "";
      try {
        await resizeTransaction.drain();
        commitDomLayout(() => gesture.end());
      } finally {
        ms.resizeDragActive = false;
        // Report the end after the final document commit and native receipt.
        emitResizeGesture(false);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp as unknown as EventListener);
    stopNativeInput = listenThisWindow<NativePointerEdge>("window.input.pointer", (event) => {
      if (event.payload.phase === "move") {
        onMove({ clientX: event.payload.x, clientY: event.payload.y });
      } else if (event.payload.phase === "up") {
        void onUp();
      }
    });
    document.body.style.cursor = d.axis === "x" ? "col-resize" : "row-resize";
  };

  const hoverCell = hover && cells.find((c) => c.group.id === hover.groupId);

  // Line index → the canonical gutter address. Convert only here, where the plane is at hand, and
  // write only named coordinates into the DOM. When it does not resolve (a border), build no address.
  const gutterKey = (d: Divider): string | undefined => {
    const owner = gutterOwnerOf(displayLayout, d.axis, d.line);
    return owner ? gutterAddress(owner.pane, owner.side) : undefined;
  };

  // Cell coordinates — pass only 4 CSS variables in px; a single CSS rule owns the offset to the
  // plane's origin (the pane inset). Real-move decision — only a panel the solution told to move is
  // animated. A whole-subtree phase selector put even zero-delta elements onto a compositing layer
  // with animation + will-change and took them off again, causing a re-raster every phase, and that
  // re-raster showed as a twitch in the DOM (address bar included) (a real incident).
  const flipMoves = (groupId?: string): boolean => !!moveOf(groupId);

  /** Move amount → start offset (px). */
  const flipOffsetPx = (groupId?: string): number => moveOf(groupId)?.dLeft ?? 0;

  const cellVars = (rect: Rect, groupId?: string) => ({
    "--l": `${rect.left}px`,
    "--t": `${rect.top}px`,
    "--w": `${rect.width}px`,
    "--h": `${rect.height}px`,
    "--flip-x": `${flipOffsetPx(groupId)}px`,
  }) as React.CSSProperties;

  const lightingFocusId = focusedPaneId ?? content.activePaneId;
  const lightingFocusCell = displayCells.find((c) => c.group.id === lightingFocusId);
  const lightingContent = displayCells.map((c) => ({
    id: c.group.id,
    style: cellVars(c.rect, c.group.id),
    moving: flipMoves(c.group.id),
  }));
  const blockedLighting = displayCells
    .filter((c) => c.group.id !== lightingFocusId && betweenIds?.includes(c.group.id))
    .map((c) => ({
      id: c.group.id,
      style: cellVars(c.rect, c.group.id),
      moving: flipMoves(c.group.id),
      amount: dimBlocked,
    }));

  // A divider is part of the corridor, not a panel — it travels when the boundary it stands on
  // moved between the departure solution and this one. Read by address, because a line's index
  // shifts when the rail moves and the address does not.
  const departedGutters = useMemo(() => {
    if (!travelFrom) return null;
    const byAddress = new Map<string, Divider>();
    for (const d of travelFrom.dividers) {
      const owner = gutterOwnerOf(travelFrom.display, d.axis, d.line);
      if (owner) byAddress.set(gutterAddress(owner.pane, owner.side), d);
    }
    return byAddress;
  }, [travelFrom]);
  const spanFlipPx = (d: Divider): number => {
    const key = gutterKey(d);
    const before = key ? departedGutters?.get(key) : undefined;
    return before ? before.x - d.x : 0;
  };
  const spanMovesPx = (d: Divider): boolean => Math.abs(spanFlipPx(d)) > 0.5;
  const gutterVars = (d: Divider) => ({
    left: `${inset + d.x}px`,
    top: `${inset + d.y}px`,
    width: `${d.w}px`,
    height: `${d.h}px`,
    "--flip-x": `${spanFlipPx(d)}px`,
  }) as React.CSSProperties;

  return (
    <div
      className="space"
      data-node={`layout/space/${content.id}`}
      data-projection={
        content.maximizedTabId
          ? "maximized"
          : focusProjectionApplied
            ? "switched"
            : "canonical"
      }
      data-focused-pane={content.activePaneId}
      data-station={arrangement.station}
      data-maximized-tab={content.maximizedTabId ?? ""}
      data-traveling={traveling ? "true" : "false"}
      data-moving-panes={(moves ?? []).map((move) => move.id).join(" ")}
      ref={containerRef}
      style={
        {
          "--pane-inset": `${inset}px`,
          "--header-h": `${HEADER_PX}px`,
          "--status-h": `${STATUS_PX}px`,
        } as React.CSSProperties
      }
    >
      {/* ── Group cell: the only positioning layer (owns the card background and radius). Inside is
          normal flex-column flow — [header][body space][status bar]. No header or status bar coordinate
          arithmetic exists. The body space stays empty and the persistent slot floats above it. */}
      {displayCells.map(({ group, rect }) => {
        const isActiveGroup = group.id === content.activePaneId;
        const active = group.tabs.find((v) => v.id === group.activeTabId);
        return (
          <div
            key={`cell-${group.id}`}
            className="pane"
            // Dimming — emit the name (level) and the strength (value) together (lib/dimLevel). CSS only draws.
            {...dimOf(group.id)}
            data-pane={group.id}
            data-node={`layout/pane/${group.id}`}
            data-wv-geometry-owner
            style={{ ...cellVars(rect, group.id), ...dimOf(group.id).style }}
            ref={rectMotion.ref}
          >
            {maxCell ? (
              /* Maximized header: a title instead of tabs and + — double click or the button restores the original split */
              <div
                className="pane-title active"
                title={t("view.restoreHint")}
                onDoubleClick={() => void execute("tab.restore", { workspace: projectId }, {})}
              >
                <span className="pane-title-icon icon-inline">
                  <Icon name="plugin" size="sm" />
                </span>
                <span className="pane-title-name">
                  {titleOf(active)}
                </span>
                <button
                  type="button"
                  className="icon-btn pane-title-btn"
                  title={t("view.restore")}
                  onClick={() => void execute("tab.restore", { workspace: projectId }, {})}
                >
                  <Icon name="minus" size="sm" />
                </button>
              </div>
            ) : splitHeaderMode === "tabs" ? (
              /* Tab mode: the tab bar (tab drag = move view, + = new tab) */
              <div className="pane-tabs">
                <ViewTabs
                  projectId={projectId}
                  group={group}
                  onTabPointerDown={onTabPointerDown}
                />
              </div>
            ) : (
              /* title mode (currently not exposed — kept in case it returns): the whole bar is the group drag handle */
              <div
                className={`pane-title${isActiveGroup ? " active" : ""}`}
                title={t("panel.move")}
                onMouseDown={startDrag("group", group.id)}
              >
                <span className="pane-title-icon icon-inline">
                  <Icon name="plugin" size="sm" />
                </span>
                <span className="pane-title-name">
                  {titleOf(active)}
                </span>
                <button
                  type="button"
                  className="icon-btn pane-title-btn"
                  title={t("panel.split")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void execute("pane.split", { workspace: projectId, pane: group.id, side: "right" }, {})}
                >
                  <Icon name="split" size="sm" />
                </button>
                <button
                  type="button"
                  className="icon-btn pane-title-btn"
                  title={t("view.close")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => group.activeTabId && void execute("tab.close", { tab: group.activeTabId }, {})}
                >
                  <Icon name="close" size="sm" />
                </button>
              </div>
            )}
            <div className="pane-body" />
            <div className="pane-status-wrap">
              <GroupStatusBar group={group} />
            </div>
          </div>
        );
      })}

      {/* ── Foreground frame: guarantees the card border (1px) above everything, an opaque terminal
          included. The slot layer covers the cell border, so the border alone is split out and floated
          (pointer-events none). Coordinates use the same variables as the cell — the arithmetic is owned
          by CSS rules. The structural border line (--bd, §B contract) is invariant — emphasis is only
          outline or background (--acc, §B4).

          The frame travels with the pane it draws. It used to be removed for the whole of a motion and
          built again at the final rect, on the reasoning that a frame decorates a settled arrangement
          — and what a person saw was every pane on the screen without its line for 148 to 372ms,
          measured 2026-08-17 across all six ways focus can move in the named window. A line that goes
          out and comes back is not a settled arrangement either. It is registered with the same rect
          tracker as the cells, so it is interpolated on the same commit with the same duration: the
          old frame does not deform and the new one does not arrive early, because there is one frame
          and it moves. ── */}
       {!replaceGeometry && displayCells.map(({ group, rect }) => (
          <NativePaneBorder
            key={`frame-${group.id}`}
            owner={`frame/${projectId}/${content.id}/${group.id}`}
            node={`layout/frame/${group.id}`}
            trackRef={rectMotion.ref}
            active={surfaceActive && paneStyle !== "flat"}
            style={cellVars(rect, group.id)}
          />
       ))}

      {/* The selection boundary travels with the pane it marks, for the same reason the frame does. */}
      {!replaceGeometry && displayCells
        .filter(({ group }) => group.id === content.activePaneId)
        .map(({ rect }) => (
          <NativeFocusBoundary
            key={`focus-frame-${content.activePaneId}`}
            owner={`focus/${projectId}/${content.id}`}
            node={`layout/focus-boundary/${content.activePaneId}`}
            trackRef={rectMotion.ref}
            active={surfaceActive && !traveling && !replaceGeometry}
            style={cellVars(rect, content.activePaneId)}
          />
        ))}

      {/* ── Persistent body layer: keyed by viewId → no remount on a move. This layer alone has a
          legitimate reason to position (an editor or terminal session survives a move between
          groups). Body area coordinates are computed by CSS rules (cell variables + size variables). ── */}
      {content.panes.flatMap((group) =>
        group.tabs.map((view) => {
          // While maximized only the maximized view is visible (full rect) — the rest stay hidden.
          const contentVisible = isViewContentVisible(
            surfaceActive,
            maxCell ? maximizedId : null,
            view.id,
            group.activeTabId,
          );
          const tabActive = maxCell ? view.id === maximizedId : view.id === group.activeTabId;
          const visibility = resolveViewVisibility(
            surfaceActive,
            true,
            tabActive,
            overlayedPane(group.id),
            traveling,
          );
          const slotRect = slotRectOf(group.id);
          // B4 restore hydration gate — a cold view (restored but not yet visible) defers its body mount
          // (spreads concurrent PTY spawns). The moment it becomes visible, or the idle chain, promotes it. Normally
          // cold is empty, so the gate costs 0. The slot div itself always renders (atomic appearance, stable address).
          const hydrated = !coldSet.has(view.id) || contentVisible;
          const presentation = presentationOf(group, view.id);
          return (
            <Fragment key={view.id}>
            {/* What the surface left when it was parked, beside the body and on the layer the
                surface was on: at the alpha it was declared with, above the lighting veil. Inside
                the body its containment would keep it off that layer. */}
            <ParkedPicture viewId={view.id} style={cellVars(slotRect, group.id)} />
            <div
              className={`tab-body${contentVisible && presentation.domSurfaceMotion === "active" ? " flip-move" : ""}`}
              // Read the same value as the cell — recombining the reasons here makes the two surfaces diverge silently.
              {...dimOf(group.id)}
              // For native click resolution (App.tsx native-mousedown → elementFromPoint).
              // The value is the id of the cell (pane) containing this slot — name and value point at the same entity (IDENTITY).
              data-pane={group.id}
              data-input-activate-pane={group.id}
              data-workspace-id={projectId}
              data-node={`layout/tab/${view.id}`}
              data-content-visible={String(visibility.contentVisible)}
              data-surface-visible={String(visibility.surfaceVisible)}
              data-visibility-reason={visibility.reason}
              data-wv-geometry-owner
              // What is inside this box is alive — a terminal, a page. It travels with the layout and
              // takes its size at once, so the thing inside lays itself out when the motion is over
              // rather than on each of its frames. The chrome around it holds the shape.
              data-rect-motion="travel"
              ref={contentVisible ? rectMotion.ref : undefined}
              // Normally an inactive slot only turns off visibility, while a slot excluded by maximize is also removed
              // from the compositing tree (viewSurfaceStyle is the single truth). Both keep the DOM and plugin instance lifetime.
              style={{
                ...cellVars(slotRect, group.id),
                ...viewSurfaceStyle(contentVisible, !!maxCell),
                ...dimOf(group.id).style,
              }}
              onMouseDownCapture={() => {
                // Move after the click is confirmed (§12-④ revision) — activation and the projection travel that
                // follows start after the gesture completes (mouseup). The whole gesture ends on stationary geometry,
                // so the click (pane tracking, xterm self-focus) is always confirmed and activation is attributed to
                // the starting slot (straddling is impossible).
                armSlotActivation(() => {
                  activatePaneIntent(group.id);
                });
              }}
            >
              {!hydrated ? null : (
                <PluginViewHost
                  viewKey={`${view.pluginId}.${view.view}`}
                  viewId={view.id}
                  projectId={projectId}
                  root={workspaceRoot}
                  region="center"
                  logicalPaneId={group.id}
                  // The same dim as the cell, from one place. Recombining the reasons here would
                  // make the veil and the surface disagree, and no veil is painted on the
                  // surface at all.
                  surfacePlacement={viewSurfacePlacementForPresentation(
                    visibility,
                    !!maxCell,
                    parkedPicture(view.id) === null
                      ? "none"
                      : parkedPictureShown(view.id) ? "shown" : "held",
                    dimStrengthOf(group.id),
                  )}
                  command={view.command ?? null}
                  // B3 restore seam — the observed runtime (cwd, plugin state). A terminal restores the spawn
                  // location, browser-like views restore state (URL etc.). With no observed value it is null (a new view).
                  restore={
                    view.cwd || view.state !== undefined
                      ? { cwd: view.cwd ?? null, state: view.state ?? null }
                      : null
                  }
                />
              )}
            </div>
            </Fragment>
          );
        }),
      )}

      {/* Focus lighting is not a per-content effect. The whole in-document work surface is dimmed once and
          only the focus pane is opened by an aperture. No filter is applied to any content subtree.
          A native surface outside the document is projected by the framework adapter from the same public
          --dim fact. */}
      <FocusLightingPlane
        scopeId={content.id}
        baseAmount={focusDim ? dimIdle : 0}
        focused={lightingFocusCell ? {
          id: lightingFocusCell.group.id,
          style: cellVars(lightingFocusCell.rect, lightingFocusCell.group.id),
          moving: flipMoves(lightingFocusCell.group.id),
        } : undefined}
        blocked={blockedLighting}
        exempt={arrangement.rail ? [railLightingExemption(arrangement.rail, inset)] : []}
        content={lightingContent}
      />

      {/* ── Resizer (the split boundary — an element whose essence is positioning). While maximized there is no boundary ── */}
      {gutters.map((d) => (
        <div
          key={gutterKey(d) ?? d.key}
          data-gutter-key={gutterKey(d)}
          data-node={gutterKey(d)}
          data-wv-occlusion="pane-gutter"
          // The highlight comes from state we own, not CSS :hover. When the pointer leaves into a native child
          // (browser surface), :hover receives no leave event and stays stuck, leaving the accent vertical line
          // across the browser at the full height of the window body (measured 2026-07-26). On top of that, :hover
          // cannot be turned on or off from a script, so it is neither drivable nor verifiable — moving ownership
          // into state solves both problems together.
          data-hover={gutterHoverKey === gutterKey(d) ? "1" : undefined}
          className={`pane-gutter ${d.axis === "x" ? "row" : "col"}${spanMovesPx(d) ? " flip-move" : ""}`}
          onPointerEnter={() => useGutterHover.getState().set(gutterKey(d) ?? null)}
          onPointerLeave={() => useGutterHover.getState().set(null)}
          style={gutterVars(d)}
          onMouseDown={onGutterDown(d)}
          onDoubleClick={onGutterDoubleClick(d)}
          title={t("divider.equalize")}
        />
      ))}

      {/* ── Drop indicator (during a drag, visual only) — body area coordinates are owned by CSS rules ── */}
      {drag && hover && hoverCell && (
        <div
          className={`drop-ind-wrap${flipMoves(hoverCell.group.id) ? " flip-move" : ""}`}
          style={cellVars(hoverCell.rect, hoverCell.group.id)}
        >
          <div className={`drop-ind ${hover.zone}`} />
        </div>
      )}
    </div>
  );
});
