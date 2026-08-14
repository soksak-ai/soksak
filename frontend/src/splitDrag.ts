import type { Axis } from "./layout";

export type SplitRect = Pick<DOMRect, "left" | "top" | "width" | "height">;
export type DividerPointerEvent = Pick<Event, "preventDefault" | "stopPropagation">;

export function claimDividerPointer(event: DividerPointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

export function ratioFromPointer(axis: Axis, rect: SplitRect, clientX: number, clientY: number): number {
  if (axis === "row") return rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  return rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
}
