// Native surface rect rule — folds a hole slot's fractional rect into the integer rect a surface can occupy.
//
// A surface(child webview, sidecar) occupies only integer pixels in window coordinates. Slots are flex/
// fractional widths, so they are almost always fractional(measured 340 / 632.2 / 866.42 / 416.78). "Slot
// position" and "surface position" therefore differ, and folding that difference separately puts each layer
// at a different position — surface here, stand-in there, capture elsewhere. Measured: the stand-in started
// 0.8px above the surface and ran 1.78px longer, pushing bottom content down by 2.6px.
//
// One rule: fold inward(ceil-left / floor-right). It is the only direction that never crosses outside the
// slot, and the surface owner(bounds computation in browser-view) already uses it. Capture, stand-in and
// surface must share this one function to resolve to the same position.
export interface SurfaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function surfaceRectOf(r: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): SurfaceRect {
  const x = Math.ceil(r.left);
  const y = Math.ceil(r.top);
  return { x, y, w: Math.floor(r.right) - x, h: Math.floor(r.bottom) - y };
}

/**
 * Target surface rect of a position-only glide.
 *
 * A DOM rect holds fractional edges and only the native surface consumes integer rects. A position-only
 * glide must not change the physical size of the source surface. The raw left edge moved by the exact CSS
 * translation determines the landing x, and width/height stay with the source native owner frame. Folding
 * both edges independently again turns 381px into 380px and deforms the surface and its outline mid-move.
 */
export function translatedSurfaceRectOf(
  r: { left: number; top: number; right: number; bottom: number },
  dx: number,
  sourceSize: { w: number; h: number },
): SurfaceRect {
  if (!Number.isFinite(dx)) throw new Error(`surface translation must be finite: ${dx}`);
  if (![sourceSize.w, sourceSize.h].every(Number.isFinite)
      || sourceSize.w < 0 || sourceSize.h < 0) {
    throw new Error(`surface source size must be finite and non-negative: ${sourceSize.w}x${sourceSize.h}`);
  }
  const source = surfaceRectOf(r);
  const translatedAnchor = surfaceRectOf({
    left: r.left + dx,
    top: r.top,
    right: r.right + dx,
    bottom: r.bottom,
  });
  return {
    x: translatedAnchor.x,
    y: source.y,
    w: sourceSize.w,
    h: sourceSize.h,
  };
}
