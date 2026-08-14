import { describe, expect, it } from "vitest";
import { viewTravelPresentation } from "./viewTravelPresentation";

describe("view travel presentation ownership", () => {
  it("a nativeSurface move drops core chrome and DOM slot motion and owns the native surface alone", () => {
    expect(viewTravelPresentation({
      traveling: true,
      moving: true,
      nativeSurface: true,
    })).toEqual({
      coreChrome: "absent",
      domSurfaceMotion: "stationary",
      nativeSurfaceMotion: "active",
    });
  });

  it("a pure DOM move drops core chrome and moves the DOM content surface alone", () => {
    expect(viewTravelPresentation({
      traveling: true,
      moving: true,
      nativeSurface: false,
    })).toEqual({
      coreChrome: "absent",
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
      coreChrome: "present",
      domSurfaceMotion: "stationary",
      nativeSurfaceMotion: "stationary",
    });
  });
});
