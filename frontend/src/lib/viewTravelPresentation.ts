export type ViewTravelPresentation = Readonly<{
  coreChrome: "present" | "absent";
  domSurfaceMotion: "active" | "stationary";
  nativeSurfaceMotion: "active" | "stationary" | "absent";
}>;

/**
 * One travel has exactly one owner of the visual coordinates.
 *
 * Core pane chrome is structure of the settled layout, not a traveling object. Remove it during travel and
 * rebuild it with a new DOM identity after landing. For a nativeSurface view the out-of-document surface owns
 * the travel, so the DOM slot is not FLIPped too. Only where there is no native surface does the DOM content
 * surface own the travel.
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
      coreChrome: "present",
      domSurfaceMotion: "stationary",
      nativeSurfaceMotion: nativeSurface ? "stationary" : "absent",
    };
  }
  return nativeSurface
    ? {
        coreChrome: "absent",
        domSurfaceMotion: "stationary",
        nativeSurfaceMotion: "active",
      }
    : {
        coreChrome: "absent",
        domSurfaceMotion: "active",
        nativeSurfaceMotion: "absent",
      };
}
