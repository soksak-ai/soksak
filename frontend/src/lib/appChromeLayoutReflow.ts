import { useLayoutEffect } from "react";
import { emitPluginEvent } from "../plugins/hooks";

/**
 * Commit edge for app chrome geometry outside ProjectSurface.
 *
 * Moving the project tabs top↔left or changing the left project rail width also changes the rect of the inner
 * slot, while the state of ProjectSurface itself may not change. ResizeObserver and rAF can stall in a
 * non-foreground window, so they cannot be the main driver of the alignment contract. The render that owns the
 * app chrome geometry emits an explicit layout.reflow event right after commit, and only adapters with an
 * out-of-document surface consume it.
 */
export function useAppChromeLayoutReflow(
  geometryKey: string,
  activeSpaceId: string | null,
): void {
  useLayoutEffect(() => {
    emitPluginEvent("layout.reflow", { activeSpaceId });
  }, [geometryKey, activeSpaceId]);
}
