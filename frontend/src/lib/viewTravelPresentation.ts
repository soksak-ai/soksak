export type ViewTravelPresentation = Readonly<{
  domSurfaceMotion: "active" | "stationary";
  nativeSurfaceMotion: "active" | "stationary" | "absent";
}>;

/**
 * One travel has exactly one owner of the visual coordinates.
 *
 * Core pane chrome is persistent structure and keeps one DOM identity through travel. For a nativeSurface
 * view the out-of-document surface owns content travel, so the DOM slot is not FLIPped too. Only where there
 * is no native surface does the DOM content surface own content travel.
 */
export function viewTravelPresentation({
  traveling,
  moving,
  nativeSurface,
}: Readonly<{
  traveling: boolean;
  moving: boolean;
  nativeSurface: boolean;
}>): ViewTravelPresentation {
  if (!traveling || !moving) {
    return {
      domSurfaceMotion: "stationary",
      nativeSurfaceMotion: nativeSurface ? "stationary" : "absent",
    };
  }
  return nativeSurface
    ? {
        domSurfaceMotion: "stationary",
        nativeSurfaceMotion: "active",
      }
    : {
        domSurfaceMotion: "active",
        nativeSurfaceMotion: "absent",
      };
}
