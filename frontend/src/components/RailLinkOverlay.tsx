import { useCallback, memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { RailRect } from "../lib/railPlacement";
import type { RailRelationState } from "../lib/railArrangement";
import { moduleState } from "../lib/moduleState";
import {
  railLinkBoxes,
} from "../lib/railLinkShape";
import { useSettings } from "../state/settings";
import { useTheme } from "../state/theme";
import {
  cssColorRGBA,
  replaceNativeDecorations,
  strokeDecoration,
} from "../lib/nativeDecorations";

/**
 * The last measured host size — the seam that keeps a remount from producing a 0 frame.
 *
 * Kept outside the hot-swap boundary. As a module-local variable the value is lost when HMR recreates the
 * module, and the 0 frame comes back — the storage and the record of "already measured" must survive together.
 */
const lastSizeRef = moduleState("components/RailLinkOverlay#lastSize", () => ({
  value: { width: 0, height: 0 },
}));

interface Size {
  width: number;
  height: number;
}

// Flash hold time for moment mode (ms) — the CSS transition owns the fade-out after release.
export const RELATION_MOMENT_MS = 600;

/**
 * Draws the relation between the rail and the bound panel as one union path. It does not read panel DOM or
 * theme borders; it consumes only ResizeObserver events and the public layout rect.
 *
 * CSS branches the presentation by the mode class of the railRelation setting (tint|moment|stroke).
 * When the resolver reports union: one composite outline. independent: independent borders around the two real
 * boxes. none: only the path-less state root. This component does not re-judge the relation branch.
 */
export const RailLinkOverlay = memo(function RailLinkOverlay({
  contentId,
  relation,
  railWidth,
  paneInset,
  railStation,
  targetRect,
  projected = false,
  nativeVisible = false,
}: {
  contentId: string;
  /** The public state produced by the arrangement resolver — this component does not re-judge the relation or border branch. */
  relation: RailRelationState;
  railWidth: number;
  /** Shared pane-grid inset. Relation geometry and pane geometry use the same inner rectangle. */
  paneInset: number;
  /** The width pushed in from the right — with a pushing sidebar the board is that much narrower. Omit it and
   *  the projection stretches, the cell runs outside the host and the path goes diagonal. */
  railStation: number;
  targetRect: RailRect | null;
  /** Whether this adjacency was formed by focus-near projection (replacement) — the only input for the seam line. */
  projected?: boolean;
  /** Only the active workspace contributes to the window-owned native plane. */
  nativeVisible?: boolean;
}) {
  const strokeWidth = useTheme((state) => state.spec.relation.strokeWidth);
  const relationStroke = useTheme((state) => state.spec.relation.stroke);
  const accent = useTheme((state) => state.colors.acc);
  const railRelation = useSettings((state) => state.railRelation);
  const railFill = useSettings((state) => state.railFill);
  const railSeamStyle = useSettings((state) => state.railSeamStyle);
  // Color of the solid seam — only when the rail moved to the board and the adjacency is **real** (when pulled,
  // the adjacency is manufactured, so it is dashed; putting that color in the user's hands too would make two
  // shapes share one value).
  // It does not overwrite the theme token, only layers onto this overlay's own scope — with two users of one
  // token, specificity settles which wins. Empty = left to the theme.
  const railPullFocused = useSettings((state) => state.railPullFocused);
  const railSolidColor = useSettings((state) => state.railSolidColor);
  const solidColorStyle =
    !railPullFocused && railSolidColor
      ? ({ "--relation-stroke": railSolidColor } as CSSProperties)
      : undefined;
  const hostRef = useRef<HTMLDivElement>(null);
  // Start from the last measured size — starting from 0 makes that frame's geometry null, so the border
  // disappears and comes back (measured 2026-08-02: every toggle sent two `host=0` frames as far as geometry).
  // This component remounts on toggle, so state cannot bridge it — the value is kept in the module.
  const [size, setSize] = useState<Size>(lastSizeRef.value);
  /**
   * Measure at **the moment** of attach.
   *
   * Starting at 0 and filling in from an effect creates a frame where `hostWidth <= 0`, and geometry is null
   * there, so the whole border disappears — that is the one blink per toggle (measured 2026-08-02: a `host=0`
   * frame was logged right after the toggle).
   *
   * The ref callback runs when the DOM attaches. Measuring there leaves no unmeasured frame.
   */
  const attach = useCallback((node: HTMLDivElement | null) => {
    hostRef.current = node;
    if (!node) return;
    const r = node.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) lastSizeRef.value = { width: r.width, height: r.height };
    setSize((cur) =>
      cur.width === r.width && cur.height === r.height ? cur : { width: r.width, height: r.height },
    );
  }, []);
  const commitSize = useCallback((width: number, height: number) => {
    setSize((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, []);

  /**
   * **Measure before drawing.** ResizeObserver arrives after paint — the frame in which the host shrank or grew
   * is drawn at the old size, and it snaps back into place on the frame after the observation arrives. That one
   * frame is the "pushed in/out and then exactly restored" the user saw.
   *
   * So it measures again after every render (before paint). When the value is unchanged setState is a no-op and
   * there is no extra render; only a changed frame draws once more before paint. The observer stays for size
   * changes that come **from outside** (window resize and the like, which happen without a render) — the two
   * are different events.
   */
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    commitSize(rect.width, rect.height);
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect;
      if (next) commitSize(next.width, next.height);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [commitSize]);

  // moment: expose the relation token briefly only at the instant the effective binding identity or geometry changes.
  const identity = targetRect
    ? `${relation.relationId}|${targetRect.left}|${targetRect.top}|${targetRect.width}|${targetRect.height}`
    : relation.relationId;
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (railRelation !== "moment") {
      setFlash(false);
      return;
    }
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), RELATION_MOMENT_MS);
    return () => clearTimeout(timer);
  }, [railRelation, identity]);

  const boxes = targetRect && relation.borderMode !== "none"
    ? railLinkBoxes(
        size.width,
        size.height,
        railWidth,
        railStation,
        targetRect,
        paneInset,
      )
    : null;
  // Card perimeter ownership is structural: .sidebar.rail-* and .pane are the
  // only owners. This relation layer is not another card and must never draw a
  // second rail/pane/union outline. It may publish the projected seam only.

  useLayoutEffect(() => {
    const owner = `relation/${contentId}`;
    const host = hostRef.current;
    const strokeValue = !railPullFocused && railSolidColor
      ? railSolidColor
      : relationStroke.includes("var(--acc)")
        ? accent
        : relationStroke;
    const color = cssColorRGBA(strokeValue);
    const strokeVisible = railRelation === "stroke" || (railRelation === "moment" && flash);
    if (!nativeVisible || !host || !boxes || !color || !strokeVisible) {
      replaceNativeDecorations(owner, []);
      return () => replaceNativeDecorations(owner, []);
    }
    const origin = host.getBoundingClientRect();
    const decorations = [];
    if (projected && railSeamStyle === "seam") {
        const eps = 1;
        const seamX = Math.abs(boxes.rail.x + boxes.rail.width - boxes.panel.x) < eps
          ? boxes.panel.x
          : Math.abs(boxes.panel.x + boxes.panel.width - boxes.rail.x) < eps
            ? boxes.rail.x
            : null;
        const y0 = Math.max(boxes.rail.y, boxes.panel.y);
        const y1 = Math.min(boxes.rail.y + boxes.rail.height, boxes.panel.y + boxes.panel.height);
        if (seamX !== null && y1 > y0) {
          decorations.push(strokeDecoration(
            `${owner}/seam`,
            `M ${seamX + origin.left} ${y0 + origin.top} L ${seamX + origin.left} ${y1 + origin.top}`,
            color,
            strokeWidth,
            [4, 4],
          ));
    }
    }
    replaceNativeDecorations(owner, decorations);
    return () => replaceNativeDecorations(owner, []);
  }, [
    accent, boxes, contentId, flash, nativeVisible, projected,
    railPullFocused, railRelation, railSeamStyle, railSolidColor, relationStroke,
    size.height, size.width, strokeWidth,
  ]);

  return (
    <div
      ref={attach}
      className={`rail-link-overlay relation-${railRelation} fill-${railFill}`}
      data-node={`relation/rail/${contentId}`}
      data-bound-tab={relation.boundTabId ?? undefined}
      data-bound-pane={relation.boundPaneId ?? undefined}
      data-connected={String(relation.connected)}
      data-placement={relation.placement}
      data-side={relation.side}
      data-relation-id={relation.relationId}
      data-border-mode={relation.borderMode}
      data-path-count={relation.pathCount}
      data-pane-inset={paneInset}
      // Measure the drawn box from outside — the border exists only inside the SVG path, so there was nowhere to
      // ask "where was it drawn". Without it the answer gets eyeballed. Host-relative px, one fact as "x,y,w,h".
      // The rail box and the board box are different things — not put in one bag. When the seam wobbles, the
      // first thing to separate is which of the two moved.
      data-rail={
        boxes
          ? `${Math.round(boxes.rail.x)},${Math.round(boxes.rail.y)},${Math.round(boxes.rail.width)},${Math.round(boxes.rail.height)}`
          : undefined
      }
      data-box={
        boxes
          ? `${Math.round(boxes.panel.x)},${Math.round(boxes.panel.y)},${Math.round(boxes.panel.width)},${Math.round(boxes.panel.height)}`
          : undefined
      }
      data-projected={projected ? "true" : undefined}
      data-flash={railRelation === "moment" ? String(flash) : undefined}
      aria-hidden="true"
      style={solidColorStyle}
    >
      {/* **No stretching.** Putting a measured size in viewBox with preserveAspectRatio="none"
          squashes or stretches the whole drawing by (new width / old width) whenever that size is
          one frame stale.
          x=0 scales to 0, so the outer edge stays put while only the inner edge moves in or
          out — exactly what the user saw (measured 2026-08-02: inward while pushing, outward while
          collapsing, and an exact return). The coordinates are already this element's CSS px, so
          they are drawn without a viewBox: a stale one draws in the wrong place, never distorted. */}
      {boxes && projected && railSeamStyle === "seam" && (
        <svg className="rail-link-canvas">
          {(() => {
            // Replacement-adjacency seam — the internal shared edge of the union outline. Natural adjacency is
            // one body and has no seam; only an adjacency formed by projection (replacement) leaves a "stitch
            // mark" as a dashed line of the same width.
            const eps = 1;
            const seamX =
              Math.abs(boxes.rail.x + boxes.rail.width - boxes.panel.x) < eps
                ? boxes.panel.x
                : Math.abs(boxes.panel.x + boxes.panel.width - boxes.rail.x) < eps
                  ? boxes.rail.x
                  : null;
            const y0 = Math.max(boxes.rail.y, boxes.panel.y);
            const y1 = Math.min(
              boxes.rail.y + boxes.rail.height,
              boxes.panel.y + boxes.panel.height,
            );
            return seamX !== null && y1 > y0 ? (
              <line
                className="rail-link-seam"
                x1={seamX}
                y1={y0}
                x2={seamX}
                y2={y1}
              />
            ) : null;
          })()}
        </svg>
      )}
    </div>
  );
});
