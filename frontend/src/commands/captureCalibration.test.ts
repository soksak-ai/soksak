// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setCaptureCalibration } from "./captureCalibration";

describe("capture compositor calibration", () => {
  afterEach(() => setCaptureCalibration(false));

  it("keeps fixed-size rulers inside the narrowest DOM-only rail", () => {
    const first = setCaptureCalibration(true);
    const second = setCaptureCalibration(true);
    const rulers = [...document.querySelectorAll<HTMLElement>("[data-capture-calibration-anchor]")];

    expect(first.visible).toBe(true);
    expect(second.visible).toBe(true);
    expect(rulers).toHaveLength(3);
    expect(rulers.map((el) => el.dataset.captureCalibrationAnchor)).toEqual(["top", "middle", "bottom"]);
    expect(rulers.every((el) => el.style.width === "40px" && el.style.height === "40px")).toBe(true);
    expect(document.querySelectorAll("#soksak-capture-calibration")).toHaveLength(1);
  });

  it("removes the whole calibration rail idempotently", () => {
    setCaptureCalibration(true);
    expect(setCaptureCalibration(false).visible).toBe(false);
    expect(setCaptureCalibration(false).visible).toBe(false);
    expect(document.querySelectorAll("[data-capture-calibration-anchor]")).toHaveLength(0);
  });
});
