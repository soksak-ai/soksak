// Semantic icon component — the only icon surface in the app. Size is fixed to 3-step tokens, which
// removes size drift structurally (the icon owns the size, not the container).
// Color is currentColor — the same color as the container text.

import { memo } from "react";
import { useSettings } from "../../state/settings";
import { getIconGlyph, useIconRegistry } from "./registry";
import type { IconName } from "./types";

const SIZE = { xs: 8, sm: 12, md: 14, lg: 16 } as const;
export type IconSize = keyof typeof SIZE;

export const Icon = memo(function Icon({
  name,
  size = "md",
}: {
  name: IconName;
  size?: IconSize;
}) {
  const setId = useSettings((s) => s.iconSet);
  // Re-render when a set is registered or removed (plugin enable/disable).
  useIconRegistry((s) => s.version);
  const g = getIconGlyph(setId, name);
  const px = SIZE[size];
  const stroke = g.f === "stroke" || g.f === "both";
  const fill = g.f === "fill" || g.f === "both";
  return (
    <svg
      viewBox={g.v}
      width={px}
      height={px}
      aria-hidden
      focusable={false}
      fill={fill ? "currentColor" : "none"}
      stroke={stroke ? "currentColor" : "none"}
      strokeWidth={stroke ? 2 : undefined}
      strokeLinecap={stroke ? "round" : undefined}
      strokeLinejoin={stroke ? "round" : undefined}
      // Body comes from trusted sources only: checked-in extraction output plus plugin data that
      // passed validateIconSetData (full-trust model — plugins already have code execution rights).
      dangerouslySetInnerHTML={{ __html: g.b }}
    />
  );
});
