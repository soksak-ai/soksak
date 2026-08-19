// DOM-lifetime-preserving visibility — switch only visibility of workspace, content, and view without unmounting.
// Coordinate moves and z correction are not the DOM's job. If an out-of-document surface needs such a
// correction, the framework providing that surface handles it inside its own adapter.
import type { CSSProperties } from "react";

/** Applies the same rule to DOM elements outside React. */
export function applyParked(el: HTMLElement, active: boolean): void {
  // Visible is not declared; the ancestor contract is inherited. In CSS visibility, a child under a hidden
  // ancestor can reappear by declaring visible itself, so across the nested workspace -> space -> tab layers
  // `visible` is not a local fact but a command that breaks the parking above.
  el.style.visibility = active ? "" : "hidden";
  el.style.pointerEvents = active ? "" : "none";
  el.style.contentVisibility = active ? "" : "hidden";
}

export function parkedStyle(active: boolean): CSSProperties {
  return {
    visibility: active ? undefined : "hidden",
    pointerEvents: active ? undefined : "none",
    contentVisibility: active ? undefined : "hidden",
  } as CSSProperties;
}
