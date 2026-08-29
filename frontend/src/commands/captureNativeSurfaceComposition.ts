import type { AppliedSurface } from "../lib/contentViews";

export interface SurfacePicturePlacement {
  id: string;
  alpha: number;
  source: { x: number; y: number; w: number; h: number };
  target: { x: number; y: number; w: number; h: number };
}

export function nativeSurfacePicturePlacements(
  _region: { x: number; y: number; w: number; h: number },
  _surfaces: readonly AppliedSurface[],
): SurfacePicturePlacement[] {
  return [];
}
