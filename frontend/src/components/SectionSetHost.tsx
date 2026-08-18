// Left sidebar host — the sidebar-left view frame. Layout is workspace.leftLayout (SplitTree<SidebarGroup>).
// [dedupe] Shares the *same* split machine as the content area (GroupArea) through splitLayout.ts:
// computeSplitLayout for % coordinate cells, hitTestCells for 5-zone (center/left/right/top/bottom) drops,
// the same drop-ind/divider visuals. The sidebar is narrow, so a col (vertical) split is natural, but it
// supports the same 4-way drop as content (left/right = row).
// keep-alive: a view opened once stays mounted (display toggle).

import { execute } from "../commands/registry";
import { gutterOwnerOf } from "../lib/gutterAddress";
import { beginGesture } from "../lib/gesture";
import { CHROME_BANDS } from "../lib/chromeBands";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { PluginViewHost } from "./PluginViewHost";
import { ViewBadge } from "./ViewBadge";
import { rafThrottle } from "../lib/rafThrottle";
import {
  computeSplitLayout,
  hitTestCells,
  cellVars,
  type DropZone,
} from "../lib/splitLayout";
import {
  useViewRegistry,
  viewsOnSurface,
  getRegisteredView,
} from "../plugins/viewRegistry";
import { useHeldWhileLeaving } from "../lib/heldWhileLeaving";
import { LAYOUT_MOTION_MS } from "../lib/layoutMotion";
import { useSectionSets } from "../state/sectionSets";
import { useSessions, type Workspace, type SidebarRegion } from "../state/sessions";
import { useTheme } from "../state/theme";
import { useViewLabels, resolveViewLabel } from "../state/viewLabels";
import {
  type SidebarGroup,
  reconcileSidebarLayout,
  sidebarViewKeys,
} from "../state/sidebarLayout";
import { isComposingEnter } from "../lib/imeKeys";
import { localize } from "../i18n";

const DRAG_THRESHOLD = 5;
// Tab row height — the same band as the content header (lib/chromeBands). Measured: before 2026-08-15 this
// was 30 while content was 33, so the two rows standing side by side were 3px off and looked different per theme.
export const SIDEBAR_HEADER_PX = CHROME_BANDS.header;
// The same pane-inset as the content group (per theme) — the sidebar body needs the same padding to align with
// content row2 (the view tabs); in a content group row2 is pushed by the inset. Same value as GroupArea.PANE_INSET.
const PANE_INSET: Record<string, number> = { flat: 0, card: 5, floating: 6 };

// Content zone → sidebar drop (the same 4 directions as content). center = join tabs, left/right = row split,
// top/bottom = col split.
export const SectionSetHost = memo(function SectionSetHost({
  region,
  workspace,
  paneId,
  focusedPluginId,
}: {
  /** Which region this host draws. The set names none — the link or the fixed choice settles it. */
  region: SidebarRegion;
  workspace: Workspace;
  paneId: string;
  /** The plugin of the focused centre view — what `individual` reads. null = none focused. */
  focusedPluginId: string | null;
}) {
  const version = useViewRegistry((s) => s.version);
  // The same pane-inset as the content group (theme paneStyle) — for row2 alignment.
  const paneStyle = useTheme((s) => s.spec.chrome.paneStyle);
  const paneInset = PANE_INSET[paneStyle] ?? 0;
  // The sections of the set standing here, in the order the set holds them.
  //
  // Which set that is comes from settings — the one linked to the focused view's plugin, or the
  // fixed one. With none standing this host is not rendered at all, which App settles.
  // Sections outside what is placed here are dropped: a set is linked to a region only when every
  // section is placed there, so this can only differ after a plugin is disabled, and the arrangement
  // is reconciled the same way it always was.
  // The place is the rule: the left edge holds one set for the installation, the other two hold the
  // focused view's plugin's set.
  const standsNow = useSectionSets((s) =>
    region === "left" ? s.left : (s.byPlugin[focusedPluginId ?? ""] ?? {})[region],
  );
  // The region's width travels with the panes, so what stands in it leaves when the space does. With
  // the content decided by this render alone, the strip is empty for the whole closing motion —
  // measured 2026-08-17, 160 points for 160ms.
  const standingId = useHeldWhileLeaving(standsNow, LAYOUT_MOTION_MS, region);
  const sets = useSectionSets((s) => s.sets);
  const registeredKeys = useMemo(() => {
    if (!standingId) return [];
    const beside = new Set(viewsOnSurface("side").map((v) => v.key));
    const set = sets.find((x) => x.id === standingId);
    return (set?.sections ?? []).filter((k) => beside.has(k));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, standingId, sets, region]);
  const reconcileSidebar = useSessions((s) => s.reconcileSidebar);
  const setSidebarTab = useSessions((s) => s.setSidebarTab);
  const stored = workspace.sidebarLayouts[region];

  // Reconcile against the registered views.
  useEffect(() => {
    reconcileSidebar(workspace.id, region, registeredKeys);
  }, [workspace.id, region, registeredKeys, reconcileSidebar]);
  const layout = useMemo(
    () => reconcileSidebarLayout(stored, registeredKeys),
    [stored, registeredKeys],
  );

  // keep-alive accumulation.
  const openedRef = useRef<Set<string>>(new Set());
  for (const k of sidebarViewKeys(layout)) openedRef.current.add(k);
  const opened = [...openedRef.current].filter((k) => registeredKeys.includes(k));

  // Compute cells and dividers with the shared machine.
  const { cells, gutters } = useMemo(() => computeSplitLayout(layout), [layout]);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  // Unique id of each cell (leaf group) = viewKeys joined (unique within the layout).
  const cellId = (g: SidebarGroup) => g.viewKeys.join("|");

  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [hover, setHover] = useState<{ cellId: string; zone: DropZone } | null>(null);

  // Pointer → cell/zone (shared hitTestCells, the same 4 directions as content). sourceCellId = the cell of the
  // dragged tab (the self-split guard applies only when that cell has 1 view — with several views an edge drop
  // may split one out).
  const hitTest = useCallback(
    (x: number, y: number, r: DOMRect, sourceCellId: string, selfCenterOnly: boolean) =>
      hitTestCells(
        x,
        y,
        r,
        cellsRef.current.map((c) => ({ value: c.value, rect: c.rect })),
        cellId,
        { chromeTop: SIDEBAR_HEADER_PX, statusPx: 0, sourceId: sourceCellId, selfCenterOnly },
      ),
    [],
  );

  // Tab drag (move a view). Below the threshold it is a click (tab switch).
  const startDrag = useCallback(
    (viewKey: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      const srcCell = cellsRef.current.find((c) => c.value.viewKeys.includes(viewKey));
      const srcCellId = srcCell ? cellId(srcCell.value) : "";
      const selfCenterOnly = !srcCell || srcCell.value.viewKeys.length <= 1;
      let moved = false;
      let rect: DOMRect | null = null;
      const updateHover = rafThrottle((x: number, y: number) => {
        const h = rect ? hitTest(x, y, rect, srcCellId, selfCenterOnly) : null;
        setHover((prev) =>
          prev?.cellId === h?.id && prev?.zone === h?.zone
            ? prev
            : h
              ? { cellId: h.id, zone: h.zone }
              : null,
        );
      });
      const onMove = (ev: MouseEvent) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
          moved = true;
          rect = containerRef.current?.getBoundingClientRect() ?? null;
          setDrag(viewKey);
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        }
        updateHover(ev.clientX, ev.clientY);
      };
      const onUp = (ev: MouseEvent) => {
        updateHover.cancel();
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (moved) {
          const h = rect ? hitTest(ev.clientX, ev.clientY, rect, srcCellId, selfCenterOnly) : null;
          if (h) {
            // Name the target group by a member that is not the dragged view — viewKey is removed from the
            // source during the move, so a targetKey equal to viewKey fails to locate the target group and the
            // view is lost (happens when splitting inside the same group). Prefer another member; otherwise the
            // active view (in a different group viewKey is absent, so it is safe).
            const targetCell = cellsRef.current.find((c) => cellId(c.value) === h.id);
            const keys = targetCell?.value.viewKeys ?? [];
            const targetKey = keys.find((k) => k !== viewKey) ?? targetCell?.value.activeViewKey ?? "";
            if (targetKey && !(h.id === srcCellId && h.zone === "center")) {
              // Move through the command — it must take the same path as the sidebar.left.move that CLI and AI
              // call, or the two diverge. The zone vocabulary is canonical in that command too (center = into).
              void execute(
                "sidebar.left.move",
                {
                  workspace: workspace.id,
                  viewKey,
                  target: targetKey,
                  zone: h.zone === "center" ? "into" : h.zone,
                },
                {},
              );
            }
          }
        } else {
          setSidebarTab(workspace.id, region, viewKey); // Click = switch tab
        }
        setDrag(null);
        setHover(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [workspace.id, region, hitTest, setSidebarTab],
  );

  // Divider drag (split ratio). The same logic as the content onGutterDown.
  const onGutterDown = (d: (typeof gutters)[number]) => (e: React.MouseEvent) => {
    e.preventDefault();
    const cont = containerRef.current;
    if (!cont) return;
    const cr = cont.getBoundingClientRect();
    const totalPx = d.dir === "row" ? cr.width : cr.height;
    const splitPx = (totalPx * d.spanPct) / 100;
    if (splitPx <= 0) return;
    const startPos = d.dir === "row" ? e.clientX : e.clientY;
    const startSizes = [...d.sizes];
    const i = d.index;
    const minFrac = 0.1;
    // Pair presentation and action in one place — preview runs every frame (straight to the store; that is
    // presentation), commit runs once on landing (through the command). The pairing is forced, so "the screen
    // changed but the ledger has nothing" is structurally impossible.
    const gesture = beginGesture<number[]>({
      preview: (sizes) =>
        // Presentation touches the store directly — it runs every frame, which is no place for a command. This
        // reads the state at that moment rather than subscribing, so it reads outside the hook (a gesture path
        // unrelated to render).
        useSessions.getState().resizeSidebar(workspace.id, region, d.splitId, sizes),
      commit: (sizes) => {
        // Address the gutter by name — the internal split id never goes outside (IDENTITY §4).
        const owner = gutterOwnerOf(layout, d.splitId, d.index, cellId);
        const key = owner?.pane.split("|")[0];
        if (key) {
          void execute(
            "sidebar.left.resize",
            { workspace: workspace.id, viewKey: key, sizes },
            {},
          );
        }
      },
    });
    const throttled = rafThrottle((sizes: number[]) => gesture.move(sizes));
    const onMove = (ev: MouseEvent) => {
      const cur = d.dir === "row" ? ev.clientX : ev.clientY;
      let delta = (cur - startPos) / splitPx;
      delta = Math.max(-(startSizes[i] - minFrac), Math.min(startSizes[i + 1] - minFrac, delta));
      const sizes = [...startSizes];
      sizes[i] = startSizes[i] + delta;
      sizes[i + 1] = startSizes[i + 1] - delta;
      throttled(sizes);
    };
    const onUp = () => {
      throttled.flush(); // Before the listeners are removed — a dropped last frame = snapback.
      gesture.end();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = d.dir === "row" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const hoverCell = hover && cells.find((c) => cellId(c.value) === hover.cellId);

  return (
    <div
      className="sidebar-left"
      // What this host stands, declared by the render that stands it.
      //
      // Nothing announced it before, so every reader inferred it from boxes and every one of them
      // polled: measured 2026-08-18, `sections.link` answered and `ui.layout.wait-settled` answered
      // and the section that had just been unlinked was still on screen, in four gates at once.
      // A declaration is what a projection owes the outside (NATIVE-SURFACES P1) — the reader is
      // told what stands rather than working it out from what has a rectangle.
      //
      // The value is registeredKeys, which is what this render mounts: the standing set filtered to
      // the sections actually placed in this region. Empty while nothing stands.
      data-region-sections={registeredKeys.join(" ")}
      data-region-standing={standingId ?? ""}
    >
      {/* Header band — same height as the content header (lib/chromeBands). No plugin fills this
          slot today, and empty is a legitimate state for this band. */}
      <div className="sidebar-left-header" data-node={`sidebar/${region}/header`} />
      {/* Grid of %-absolute cells (same model as a content space) — the footer is below it, outside the flow. */}
      <div
        className="left-panes"
        ref={containerRef}
        style={
          // --drop-top-h:0 → the drop placeholder (.drop-ind-wrap) covers the whole cell, tab row included.
          // --header-h is left alone (plugin row2 band height inherits the same 33px as the content view-tab band).
          // (The hit-test header offset is owned separately by JS SIDEBAR_HEADER_PX — visual and verdict are split.)
          // With no pins at all the grid collapses — the projection slots take the whole rail (the empty state of R4).
          {
            "--drop-top-h": "0px",
            "--status-h": "0px",
            "--pane-inset": `${paneInset}px`,
            ...(registeredKeys.length === 0 ? { display: "none" } : {}),
          } as CSSProperties
        }
      >
        {/* Leaf pane — %-absolute, like a content space. Inside = [tab row][body]. */}
        {cells.map(({ value: group, rect }, i) => (
          <div
            key={cellId(group)}
            className="left-pane"
            // Cell drop target (E2E/AI): ui.input.drag's `to` points at the cell (by index) and `zone` selects
            // split or join. Cells in the left area have no issued id, so they are addressed by index (content
            // uses layout/pane/<pan-id>).
            data-node={`pane/${region}/${i}`}
            style={cellVars(rect) as CSSProperties}
          >
            <SidebarLeaf
              region={region}
              group={group}
              workspace={workspace}
              paneId={paneId}
              opened={opened}
              dragging={drag}
              startDrag={startDrag}
            />
          </div>
        ))}

        {/* Split divider — same class and visuals as content. */}
        {gutters.map((d) => (
          <div
            key={`gutter-${d.splitId}-${d.index}`}
            className={`pane-gutter ${d.dir}`}
            data-wv-occlusion="pane-gutter"
            style={
              d.dir === "row"
                ? { left: `${d.rect.left}%`, top: `${d.rect.top}%`, height: `${d.rect.height}%` }
                : { left: `${d.rect.left}%`, top: `${d.rect.top}%`, width: `${d.rect.width}%` }
            }
            onMouseDown={onGutterDown(d)}
          />
        ))}

        {/* Drop indicator — same as content (drop-ind-wrap + drop-ind.zone). */}
        {drag && hover && hoverCell && (
          <div className="drop-ind-wrap" style={cellVars(hoverCell.rect) as CSSProperties}>
            <div className={`drop-ind ${hover.zone}`} />
          </div>
        )}
      </div>

      {/* The frame is the contract and the body is the plugin's share — an empty footer is the frame,
          not an absence. Made conditional, only a window with no plugin gets a different skeleton, and
          next to another window it is off by one row (measured 2026-08-15).
          Nothing fills it: `rail-footer` was a placement a plugin asked for, and a position inside a
          region is an order the person arranged, not a place (2026-08-16). */}
      <div className="sidebar-left-footer" data-node={`sidebar/${region}/footer`} />
    </div>
  );
});

// One leaf = the tab row (that group's views) + the active view body. keep-alive: opened views stay mounted, display toggles.
function SidebarLeaf({
  region,
  group,
  workspace,
  paneId,
  opened,
  dragging,
  startDrag,
}: {
  /** The region this leaf is drawn in. It was written `left` at the view host below, so a section
   *  the right region drew answered `left` when asked where it is — measured 2026-08-17. */
  region: SidebarRegion;
  group: SidebarGroup;
  workspace: Workspace;
  paneId: string;
  opened: string[];
  dragging: string | null;
  startDrag: (viewKey: string) => (e: React.MouseEvent) => void;
}) {
  const setLabel = useViewLabels((s) => s.setLabel);
  const labelVersion = useViewLabels((s) => s.labels);
  void labelVersion;
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const active = group.activeViewKey;
  const hosted = opened.filter((k) => group.viewKeys.includes(k));

  return (
    <div className="sidebar-left-section">
      <div className="sidebar-left-tabs">
        {group.viewKeys.map((key) => {
          const reg = getRegisteredView(key);
          const fallback = reg ? localize(reg.decl.title) : key;
          const label = resolveViewLabel(key, fallback);
          const editing = editingKey === key;
          // Reuses the *same structure and design* as the content tab (.space-tab, the top tab row) — .space-tab.editing
          // owns the edit box and .space-tab-rename (transparent, font:inherit) owns the input, so font and shape match
          // the label. sidebar-left-tab is only a drag marker.
          return (
            <div
              key={key}
              className={`space-tab sidebar-left-tab${active === key ? " active" : ""}${editing ? " editing" : ""}${dragging === key ? " dragging" : ""}`}
              data-node={`tab/${region}/${key}`}
              title={label}
              onMouseDown={editing ? undefined : startDrag(key)}
              onDoubleClick={() => setEditingKey(key)}
            >
              {editing ? (
                <input
                  className="space-tab-rename"
                  data-node={`tab/${region}/${key}/rename`}
                  defaultValue={label}
                  autoFocus
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    setLabel(key, e.target.value === fallback ? "" : e.target.value);
                    setEditingKey(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (isComposingEnter(e)) return;
                    if (e.key === "Enter") {
                      const v = e.currentTarget.value;
                      setLabel(key, v === fallback ? "" : v);
                      setEditingKey(null);
                    } else if (e.key === "Escape") setEditingKey(null);
                  }}
                />
              ) : (
                <>
                  <span className="space-tab-title">{label}</span>
                  <ViewBadge viewKey={key} />
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="sidebar-left-stack" data-node={`body/${region}`}>
        {hosted.map((k) => (
          <div
            key={k}
            className="sidebar-left-body"
            // Which section this is, on the screen. A region that stands is measured by its width, and
            // a width does not name whose section is in it — a browser was focused and the file
            // tree stood beside it, and every gate about the arrangement passed. So the key is on the
            // element, and what stands can be read rather than assumed.
            data-node={`section/${region}/${k}`}
            style={{ display: active === k ? "flex" : "none" }}
          >
            <PluginViewHost
              viewKey={k}
              projectId={workspace.id}
              root={workspace.root}
              region={region}
              paneId={paneId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
