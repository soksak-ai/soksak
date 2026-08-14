import type { RailRect } from "./railPlacement";

/**
 * Merges the rail and the attached plane into one projection box during FLOW movement. PIN must
 * not use this function and must keep the real plane rect; otherwise the gap between detached
 * planes becomes a fake composited surface.
 */
export function flowRailBoundBox(station: number, bound: RailRect): RailRect {
  const right = bound.left + bound.width;
  if (right <= station) {
    return { left: bound.left, top: bound.top, width: station - bound.left, height: bound.height };
  }
  return { left: station, top: bound.top, width: right - station, height: bound.height };
}
