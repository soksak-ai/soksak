import { describe, expect, it } from "vitest";
import { viewTravelPresentation } from "./viewTravelPresentation";

describe("view travel presentation ownership", () => {
  it("a nativeSurface move keeps core chrome and lets the native surface own content motion", () => {
    expect(viewTravelPresentation({
      traveling: true,
      moving: true,
      nativeSurface: true,
    })).toEqual({
      domSurfaceMotion: "stationary",
      nativeSurfaceMotion: "active",
    });
  });

  it("a pure DOM move keeps core chrome and moves the DOM content surface alone", () => {
    expect(viewTravelPresentation({
      traveling: true,
      moving: true,
      nativeSurface: false,
    })).toEqual({
      domSurfaceMotion: "active",
      nativeSurfaceMotion: "absent",
    });
  });

  it("a settled pane builds chrome again and owns no travel motion", () => {
    expect(viewTravelPresentation({
      traveling: false,
      moving: false,
      nativeSurface: true,
    })).toEqual({
      domSurfaceMotion: "stationary",
      nativeSurfaceMotion: "stationary",
    });
  });
});
