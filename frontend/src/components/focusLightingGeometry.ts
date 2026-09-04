import type { CSSProperties } from "react";
import type { LightingExemption } from "./FocusLightingPlane";
import type { Rect } from "../lib/railArrangement";

/**
 * The rail's rect on the plane, declared in the host's coordinates: the plane's origin is the host
 * inset by the pane inset (UI-GEOMETRY R1b).
 */
export function railLightingExemption(rail: Rect, paneInset: number): LightingExemption {
  if (!(Number.isFinite(rail.width) && rail.width > 0)) {
    throw new Error(`rail lighting width must be positive: ${rail.width}`);
  }
  return {
    id: "left-rail",
    style: {
      x: `${paneInset + rail.left}px`,
      y: `${paneInset + rail.top}px`,
      width: `${rail.width}px`,
      height: `${rail.height}px`,
    } as CSSProperties,
  };
}
