import { useId, type CSSProperties } from "react";

/** Pane box projected onto the lighting plane. Coordinate math ends in one place, GroupArea's cellVars. */
export type LightingRegion = {
  id: string;
  style: CSSProperties;
  moving?: boolean;
};

/** Chrome box excluded from the lighting. Owns the SVG geometry directly. */
export type LightingExemption = {
  id: string;
  style: CSSProperties;
};

type BlockedLightingRegion = LightingRegion & { amount: number };

/**
 * Workspace lighting is not a property of the content but a single visual plane placed over it.
 *
 * A black base veil darkens the whole workspace, and only the focused aperture exposes the original
 * pixels. Blocked regions are subtracted from the base mask too and painted exactly once at their own
 * density. So DOM, WebGL, and out-of-document native surfaces produce the same result without any
 * filter/opacity on the content subtree. The SVG owns visuals only and does not participate in input
 * or the accessibility tree.
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
  const maskId = `focus-light-${useId().replace(/:/g, "")}`;
  const regionClass = (moving?: boolean) =>
    `focus-lighting-region${moving ? " flip-move" : ""}`;

  return (
    <svg
      className="focus-lighting-plane"
      data-node={`focus-lighting/${scopeId}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <mask
          id={maskId}
          className="focus-lighting-mask"
          data-node={`focus-lighting/${scopeId}/mask`}
          x="0"
          y="0"
          width="100%"
          height="100%"
          maskUnits="userSpaceOnUse"
        >
          <rect
            data-node={`focus-lighting/${scopeId}/mask/base`}
            data-lighting-mask-base="white"
            width="100%"
            height="100%"
            fill="white"
          />
          {exempt.map((region) => (
            <rect
              key={`exempt-${region.id}`}
              data-node={`focus-lighting/${scopeId}/exempt/${region.id}`}
              data-lighting-exempt={region.id}
              style={region.style}
              fill="black"
            />
          ))}
          {content.map((region) => (
            <rect
              key={`content-${region.id}`}
              className={regionClass(region.moving)}
              data-node={`focus-lighting/${scopeId}/content/${region.id}`}
              data-lighting-content={region.id}
              style={region.style}
              fill="white"
            />
          ))}
          {focused && (
            <rect
              className={regionClass(focused.moving)}
              data-node={`focus-lighting/${scopeId}/aperture/${focused.id}`}
              data-lighting-aperture={focused.id}
              style={focused.style}
              fill="black"
            />
          )}
          {blocked.map((region) => (
            <rect
              key={`cutout-${region.id}`}
              className={regionClass(region.moving)}
              data-node={`focus-lighting/${scopeId}/cutout/${region.id}`}
              data-lighting-cutout={region.id}
              style={region.style}
              fill="black"
            />
          ))}
        </mask>
      </defs>

      <rect
        className="focus-lighting-base"
        data-node={`focus-lighting/${scopeId}/base`}
        data-lighting-base="idle"
        width="100%"
        height="100%"
        fill="black"
        fillOpacity={baseAmount}
        mask={`url(#${maskId})`}
      />

      {blocked.map((region) => (
        <rect
          key={`blocked-${region.id}`}
          className={regionClass(region.moving)}
          data-node={`focus-lighting/${scopeId}/blocked/${region.id}`}
          data-lighting-blocked={region.id}
          style={region.style}
          fill="black"
          fillOpacity={region.amount}
        />
      ))}
    </svg>
  );
}
