export const CAPTURE_CALIBRATION_ID = "soksak-capture-calibration";
const CALIBRATION_COLOR = "#0000ff";
const CALIBRATION_ANCHORS = [
  { name: "top", top: "4px" },
  { name: "middle", top: "calc(50% - 20px)" },
  { name: "bottom", bottom: "4px" },
] as const;

function createRuler(anchor: (typeof CALIBRATION_ANCHORS)[number]): HTMLDivElement {
  const ruler = document.createElement("div");
  ruler.dataset.captureCalibrationAnchor = anchor.name;
  Object.assign(ruler.style, {
    position: "fixed",
    left: "4px",
    width: "40px",
    height: "40px",
    background: CALIBRATION_COLOR,
    pointerEvents: "none",
    zIndex: "2147483647",
    ...(anchor.name === "bottom" ? { bottom: anchor.bottom } : { top: anchor.top }),
  });
  return ruler;
}

/**
 * WindowServer can crop and reproject the window backing during a transition, so at least one
 * ruler must remain: the same 40×40 ruler is placed at the top, middle and bottom of the left
 * DOM rail, which has no native content hole.
 * Reapplying the same visible state does not rebuild the DOM; an incomplete existing root is repaired.
 */
export function setCaptureCalibration(visible: boolean) {
  let root = document.getElementById(CAPTURE_CALIBRATION_ID) as HTMLDivElement | null;
  if (visible) {
    if (!root) {
      root = document.createElement("div");
      root.id = CAPTURE_CALIBRATION_ID;
      root.dataset.node = "capture-calibration";
      document.body.append(root);
    }
    const names = [...root.querySelectorAll<HTMLElement>("[data-capture-calibration-anchor]")]
      .map((el) => el.dataset.captureCalibrationAnchor);
    if (JSON.stringify(names) !== JSON.stringify(CALIBRATION_ANCHORS.map((anchor) => anchor.name))) {
      root.replaceChildren(...CALIBRATION_ANCHORS.map(createRuler));
    }
  } else if (root) {
    root.remove();
    root = null;
  }

  const rulers = root
    ? [...root.querySelectorAll<HTMLElement>("[data-capture-calibration-anchor]")]
    : [];
  const rects = rulers.map((ruler) => {
    const rect = ruler.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  });
  return {
    visible: Boolean(root),
    color: CALIBRATION_COLOR,
    rect: rects[0] ?? null,
    rects,
  };
}
