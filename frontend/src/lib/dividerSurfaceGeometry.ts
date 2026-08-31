import type { NativeSurfaceFrame } from "@min-median-max/wails-service-native-compositor";
import { projectRailCssRect } from "./railPlacement";

export interface DividerTargetCell {
  id: string;
  rect: { left: number; top: number; width: number; height: number };
}

const numberVar = (element: HTMLElement, name: string): number => {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
};

const cssPixel = (value: number): number => Math.round(value * 100) / 100;

/**
 * Calculates surface rectangles from the target split layout without changing the document.
 * Fixed offsets inside each pane are preserved, so plugin chrome remains provider-owned.
 */
export function dividerSurfaceGeometry(
  host: HTMLElement,
  cells: readonly DividerTargetCell[],
  railStation: number,
  railWidthPx: number,
): Map<string, NativeSurfaceFrame> {
  const hostRect = host.getBoundingClientRect();
  const inset = numberVar(host, "--pane-inset");
  const targets = new Map(cells.map((cell) => [cell.id, cell.rect]));
  const frames = new Map<string, NativeSurfaceFrame>();

  for (const pane of host.querySelectorAll<HTMLElement>("[data-node^='layout/pane/'][data-pane]")) {
    const paneId = pane.dataset.pane ?? "";
    const target = targets.get(paneId);
    if (!target) continue;
    const projected = railWidthPx > 0
      ? projectRailCssRect(target, railStation)
      : { railLeft: 0, railWidth: 0 };
    const nextPane = {
      left: hostRect.left + hostRect.width * target.left / 100 + projected.railLeft * railWidthPx + inset,
      top: hostRect.top + hostRect.height * target.top / 100 + inset,
      width: hostRect.width * target.width / 100 + projected.railWidth * railWidthPx - inset * 2,
      height: hostRect.height * target.height / 100 - inset * 2,
    };
    const currentPane = pane.getBoundingClientRect();
    for (const declaration of host.querySelectorAll<HTMLElement>(
      `[data-pane="${CSS.escape(paneId)}"] [data-native-surface][data-native-surface-id]`,
    )) {
      const id = declaration.dataset.nativeSurfaceId ?? "";
      if (!id) continue;
      const current = declaration.getBoundingClientRect();
      const rightInset = currentPane.right - current.right;
      const bottomInset = currentPane.bottom - current.bottom;
      const leftInset = current.left - currentPane.left;
      const topInset = current.top - currentPane.top;
      frames.set(id, {
        x: cssPixel(nextPane.left + leftInset),
        y: cssPixel(nextPane.top + topInset),
        width: cssPixel(Math.max(0, nextPane.width - leftInset - rightInset)),
        height: cssPixel(Math.max(0, nextPane.height - topInset - bottomInset)),
      });
    }
  }
  return frames;
}
