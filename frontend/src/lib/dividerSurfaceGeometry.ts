import type { NativeSurfaceFrame } from "@soksak/soksak-service-native-compositor";

export interface DividerTargetCell {
  id: string;
  /** The pane's rect on the plane, in px. */
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
): Map<string, NativeSurfaceFrame> {
  const hostRect = host.getBoundingClientRect();
  const inset = numberVar(host, "--pane-inset");
  const targets = new Map(cells.map((cell) => [cell.id, cell.rect]));
  const frames = new Map<string, NativeSurfaceFrame>();

  for (const pane of host.querySelectorAll<HTMLElement>("[data-node^='layout/pane/'][data-pane]")) {
    const paneId = pane.dataset.pane ?? "";
    const target = targets.get(paneId);
    if (!target) continue;
    // The plane's origin is the host inset by the pane inset (UI-GEOMETRY R1b).
    const nextPane = {
      left: hostRect.left + inset + target.left,
      top: hostRect.top + inset + target.top,
      width: target.width,
      height: target.height,
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
