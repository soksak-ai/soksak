import { type CSSProperties } from "react";

/** Pane box projected onto the lighting plane. Coordinate math ends in one place, GroupArea's cellVars. */
export type LightingRegion = {
  id: string;
  style: CSSProperties;
  moving?: boolean;
};

/** Chrome box explicitly named as exempt from lighting. */
export type LightingExemption = {
  id: string;
  style: CSSProperties;
};

type BlockedLightingRegion = LightingRegion & { amount: number };

/**
 * Workspace lighting is not a property of the content but pane-local rectangles in a visual plane.
 *
 * Idle and blocked regions are each painted exactly once; focused and exempt regions paint nothing.
 * A full-window SVG luminance mask is forbidden: WebCore converts it to an image buffer while its
 * geometry moves, consuming the render path the drag needs. Native surfaces receive the same amount
 * through their alpha declaration. This plane owns visuals only and does not participate in input or
 * the accessibility tree.
 */
export function FocusLightingPlane({
  scopeId,
  baseAmount,
  focused,
  blocked,
  exempt,
  content,
}: {
  /** Stable space identity that identifies the lighting plane one-to-one within a workspace. */
  scopeId: string;
  baseAmount: number;
  focused?: LightingRegion;
  blocked: BlockedLightingRegion[];
  exempt: LightingExemption[];
  /** Every tabview/pane box. Restores the veil behind the rail exemption. */
  content: LightingRegion[];
}) {
  const regionClass = (moving?: boolean) =>
    `focus-lighting-region${moving ? " flip-move" : ""}`;
  const geometryKey = (style: CSSProperties) => {
    const values = style as Record<string, string | number | undefined>;
    return ["--l", "--t", "--w", "--h"].map((key) => String(values[key] ?? "")).join("|");
  };
  const focusedGeometry = focused ? geometryKey(focused.style) : null;
  const blockedGeometries = new Set(blocked.map((region) => geometryKey(region.style)));
  const exemptionStyle = (style: CSSProperties): CSSProperties => {
    const svg = style as CSSProperties & { x?: string; y?: string };
    return {
      ...style,
      position: "absolute",
      left: svg.x,
      top: svg.y,
      width: style.width,
      height: style.height,
    };
  };

  return (
    <div
      className="focus-lighting-plane"
      data-node={`focus-lighting/${scopeId}`}
      aria-hidden="true"
    >
      {exempt.map((region) => (
        <div key={`exempt-${region.id}`} data-node={`focus-lighting/${scopeId}/exempt/${region.id}`}
          data-lighting-exempt={region.id} style={exemptionStyle(region.style)} />
      ))}
      {content.filter((region) => geometryKey(region.style) !== focusedGeometry
        && !blockedGeometries.has(geometryKey(region.style))).map((region) => (
        <div key={`idle-${region.id}`} className={regionClass(region.moving)}
          data-node={`focus-lighting/${scopeId}/content/${region.id}`} data-lighting-content={region.id}
          data-lighting-base="idle" style={{ ...region.style, background: "black", opacity: baseAmount }} />
      ))}
      {focused && <div className={regionClass(focused.moving)}
        data-node={`focus-lighting/${scopeId}/aperture/${focused.id}`}
        data-lighting-aperture={focused.id} style={focused.style} />}

      {blocked.map((region) => (
        <div
          key={`blocked-${region.id}`}
          className={regionClass(region.moving)}
          data-node={`focus-lighting/${scopeId}/blocked/${region.id}`}
          data-lighting-blocked={region.id}
          style={{ ...region.style, background: "black", opacity: region.amount }}
        />
      ))}
    </div>
  );
}
