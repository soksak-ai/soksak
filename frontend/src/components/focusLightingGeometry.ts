import type { CSSProperties } from "react";
import type { LightingExemption } from "./FocusLightingPlane";

/** Declares the same exempt coordinates as the left rail's actual CSS placement formula. */
export function railLightingExemption(
  railWidthPx: number,
  railStation: number,
): LightingExemption {
  if (!(Number.isFinite(railWidthPx) && railWidthPx > 0)) {
    throw new Error(`rail lighting width must be positive: ${railWidthPx}`);
  }
  if (!(Number.isFinite(railStation) && railStation >= 0 && railStation <= 100)) {
    throw new Error(`rail lighting station must be within 0..100: ${railStation}`);
  }
  return {
    id: "left-rail",
    style: {
      x: `calc(${railStation}% - ${(railWidthPx * railStation) / 100}px)`,
      y: "0px",
      width: `${railWidthPx}px`,
      height: "100%",
    } as CSSProperties,
  };
}
