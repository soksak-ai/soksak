export const CAPTURE_MOTION_ANCHOR_ATTR = "data-capture-motion-anchor";
export const CAPTURE_MOTION_ANCHOR_SIZE = 12;
const STYLE_ID = "soksak-capture-motion-anchor-style";
const X_PROP = "--capture-motion-anchor-x";
const Y_PROP = "--capture-motion-anchor-y";
const COLOR_PROP = "--capture-motion-anchor-color";

interface AnchorDeclaration {
  address: string;
  color: string;
  x: number;
  y: number;
  restorePosition: string;
  changedPosition: boolean;
}

const declarations = new Map<HTMLElement, AnchorDeclaration>();
const observers = new Map<HTMLElement, MutationObserver>();

export interface CaptureMotionAnchorTarget {
  address: string;
  color: string;
  host: HTMLElement;
  x?: number;
  y?: number;
}

function currentAnchors(document: Document): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${CAPTURE_MOTION_ANCHOR_ATTR}]`)];
}

function ensureStyle(document: Document): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [${CAPTURE_MOTION_ANCHOR_ATTR}]::after {
      content: "" !important;
      position: absolute !important;
      left: var(${X_PROP}, 0px) !important;
      top: var(${Y_PROP}, 0px) !important;
      width: ${CAPTURE_MOTION_ANCHOR_SIZE}px !important;
      height: ${CAPTURE_MOTION_ANCHOR_SIZE}px !important;
      background: var(${COLOR_PROP}) !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
    }
  `;
  document.head.append(style);
}

function applyDeclaration(host: HTMLElement, declaration: AnchorDeclaration): void {
  if (host.getAttribute(CAPTURE_MOTION_ANCHOR_ATTR) !== declaration.address) {
    host.setAttribute(CAPTURE_MOTION_ANCHOR_ATTR, declaration.address);
  }
  if (declaration.changedPosition && host.style.position !== "relative") {
    host.style.position = "relative";
  }
  const values = [
    [X_PROP, `${declaration.x}px`],
    [Y_PROP, `${declaration.y}px`],
    [COLOR_PROP, declaration.color],
  ] as const;
  for (const [name, value] of values) {
    if (host.style.getPropertyValue(name) !== value) host.style.setProperty(name, value);
  }
}

function removeAnchor(host: HTMLElement): void {
  observers.get(host)?.disconnect();
  observers.delete(host);
  const declaration = declarations.get(host);
  declarations.delete(host);
  host.removeAttribute(CAPTURE_MOTION_ANCHOR_ATTR);
  host.style.removeProperty(X_PROP);
  host.style.removeProperty(Y_PROP);
  host.style.removeProperty(COLOR_PROP);
  if (declaration?.changedPosition) host.style.position = declaration.restorePosition;
}

/**
 * DOM anchor that compares the motion path of an external surface and a DOM slot in the same PNG.
 *
 * The anchor is a child of the tab slot resolved from the public address, so it inherits the slot's
 * transform. Comparing its x coordinate against the same-colored anchor on the page surface detects,
 * frame by frame, a stale surface that matches only at the final resting position. Each call reapplies
 * the whole declaration set; an empty array removes them.
 */
export function setCaptureMotionAnchors(
  document: Document,
  targets: readonly CaptureMotionAnchorTarget[],
) {
  ensureStyle(document);
  for (const host of [...declarations.keys()]) removeAnchor(host);

  for (const target of targets) {
    const declaration: AnchorDeclaration = {
      address: target.address,
      color: target.color,
      x: target.x ?? 0,
      y: target.y ?? 0,
      restorePosition: target.host.style.position,
      changedPosition:
        target.host.ownerDocument.defaultView?.getComputedStyle(target.host).position === "static",
    };
    declarations.set(target.host, declaration);
    applyDeclaration(target.host, declaration);
    const observer = new MutationObserver(() => applyDeclaration(target.host, declaration));
    observer.observe(target.host, {
      attributes: true,
      attributeFilter: [CAPTURE_MOTION_ANCHOR_ATTR, "style"],
    });
    observers.set(target.host, observer);
  }

  return {
    visible: targets.length > 0,
    count: targets.length,
    anchors: currentAnchors(document).map((host) => {
      const rect = host.getBoundingClientRect();
      const x = Number.parseFloat(host.style.getPropertyValue(X_PROP)) || 0;
      const y = Number.parseFloat(host.style.getPropertyValue(Y_PROP)) || 0;
      return {
        address: host.getAttribute(CAPTURE_MOTION_ANCHOR_ATTR) ?? "",
        color: host.style.getPropertyValue(COLOR_PROP),
        rect: { x: rect.x + x, y: rect.y + y, w: CAPTURE_MOTION_ANCHOR_SIZE, h: CAPTURE_MOTION_ANCHOR_SIZE },
      };
    }),
  };
}
