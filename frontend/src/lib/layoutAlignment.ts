// Where every native surface and every region is, in one instant.
//
// A native surface is composited above the document and its rectangle is written by the document:
// the declaring element's box is measured and committed, and the native layer applies what it was
// given. Both halves then agree with each other whatever the screen shows — a composition reading
// answers zero drift while the page is drawn 160 points off its pane, because the number it compares
// against went stale with the commit.
//
// So the measurement is the element **now** against the surface **now**, with the regions and panes
// they sit beside read in the same pass. Two readings a frame apart cannot tell a window mid-motion
// from a window that is wrong — measured 2026-08-17, an 83 point overlap that was two honest
// readings of a travelling pane.
import { contentViewHost, nativeSurfaceDeclarations, type AppliedSurface } from "./contentViews";

/** One rectangle, in CSS pixels from the window's top left. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One surface, from both clocks. */
export interface SurfaceAlignment {
  id: string;
  /** The declaring element's box in this instant. */
  dom: Box;
  /** The box the last commit sent, as the observer wrote it back on the element. */
  declared: Box | null;
  /** The box the native layer holds. */
  applied: Box | null;
  visible: boolean;
  /** dom vs declared — how far the declaration has fallen behind the element. */
  lag: number | null;
  /** declared vs applied — what the native layer did with what it was given. */
  drift: number | null;
  /** dom vs applied — the whole distance between a pane and the page drawn for it. */
  off: number | null;
}

export interface LayoutAlignment {
  regions: Array<{ region: string } & Box>;
  panes: Array<{ pane: string } & Box>;
  /** The lines drawn around the panes: one frame per pane, and the boundary on the focused one. They
   *  are a separate element from the pane they outline, so whether they are on the screen is a
   *  different fact from whether the pane is. */
  frames: Array<{ pane: string } & Box>;
  boundaries: Array<{ pane: string } & Box>;
  surfaces: SurfaceAlignment[];
  worstOff: number;
  worstLag: number;
  worstDrift: number;
  /** How far the furthest page is drawn into a region's band. A native surface is composited above
   *  the document, so a page reaching into a region is drawn over it. */
  worstOver: number;
}

/** How far apart two rectangles are, as the largest difference over the four components. One number
 *  per pair, because a pane and its page are either in the same place or they are not. */
export function apart(a: Box, b: Box): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
}

const rounded = (value: number): number => +value.toFixed(2);

export const boxOf = (rect: { left: number; top: number; width: number; height: number }): Box => ({
  x: rounded(rect.left),
  y: rounded(rect.top),
  w: rounded(rect.width),
  h: rounded(rect.height),
});

/** The document half: every declared surface, every region, every pane, measured in one pass. */
export function documentAlignment(): {
  regions: LayoutAlignment["regions"];
  panes: LayoutAlignment["panes"];
  frames: LayoutAlignment["frames"];
  boundaries: LayoutAlignment["boundaries"];
  declarations: Array<{ id: string; dom: Box; declared: Box | null }>;
} {
  const regions = boxesOf("[data-node$='rail/left'],[data-node$='sidebar/right']").map((box) => ({
    region: box.node.endsWith("rail/left") ? "left" : "right",
    ...box.box,
  }));
  const panes = boxesOf("[data-node*='layout/pane/']").map((box) => ({
    pane: box.node.slice(box.node.lastIndexOf("/") + 1),
    ...box.box,
  }));
  const frames = boxesOf("[data-node^='layout/frame/']").map((box) => ({
    pane: box.node.slice(box.node.lastIndexOf("/") + 1),
    ...box.box,
  }));
  const boundaries = boxesOf("[data-node^='layout/focus-boundary/']").map((box) => ({
    pane: box.node.slice(box.node.lastIndexOf("/") + 1),
    ...box.box,
  }));
  const declarations = nativeSurfaceDeclarations().map((element) => ({
    id: element.dataset.nativeSurfaceId ?? "",
    dom: boxOf(element.getBoundingClientRect()),
    declared: declaredOf(element),
  }));
  return { regions, panes, frames, boundaries, declarations };
}

/** The two halves put together. The applied side is passed in rather than fetched, so a caller that
 *  already holds one — a frame recorder that must not wait on a round trip mid-frame — states which
 *  reading it is using. */
export function alignmentOf(
  document: ReturnType<typeof documentAlignment>,
  applied: readonly AppliedSurface[],
): LayoutAlignment {
  const appliedById = new Map(applied.map((surface) => [surface.id, surface]));
  const surfaces: SurfaceAlignment[] = document.declarations.map((declaration) => {
    const held = appliedById.get(declaration.id);
    const appliedBox = held
      ? { x: rounded(held.x), y: rounded(held.y), w: rounded(held.w), h: rounded(held.h) }
      : null;
    return {
      id: declaration.id,
      dom: declaration.dom,
      declared: declaration.declared,
      applied: appliedBox,
      visible: held?.visible ?? false,
      lag: declaration.declared ? apart(declaration.dom, declaration.declared) : null,
      drift: declaration.declared && appliedBox ? apart(declaration.declared, appliedBox) : null,
      off: appliedBox ? apart(declaration.dom, appliedBox) : null,
    };
  });
  // Only what is on the screen. A parked surface is not where its pane is and does not need to be —
  // it has stepped aside so the document can draw over its place, and its picture is what a person
  // is looking at. Counting it answers a question about a rectangle nobody can see.
  const worst = (pick: (s: SurfaceAlignment) => number | null): number =>
    surfaces.reduce((most, surface) => (surface.visible ? Math.max(most, pick(surface) ?? 0) : most), 0);
  // Overlap, not distance. A region collapsed to no width still has a position — the right rail is
  // at the window's edge with w=0 — and measuring from its edge alone called every page on the screen
  // 994 points "over" it. What counts is how much of the region's band a page actually covers.
  let worstOver = 0;
  for (const region of document.regions) {
    if (region.w <= 0) continue;
    for (const surface of surfaces) {
      if (!surface.visible || !surface.applied) continue;
      const overlap =
        Math.min(region.x + region.w, surface.applied.x + surface.applied.w) -
        Math.max(region.x, surface.applied.x);
      if (overlap > worstOver) worstOver = overlap;
    }
  }
  return {
    regions: document.regions,
    panes: document.panes,
    frames: document.frames,
    boundaries: document.boundaries,
    surfaces,
    worstOff: worst((s) => s.off),
    worstLag: worst((s) => s.lag),
    worstDrift: worst((s) => s.drift),
    worstOver,
  };
}

/** The whole reading, both halves, for a caller that can wait. */
export async function readAlignment(): Promise<LayoutAlignment> {
  const half = documentAlignment();
  const applied = await contentViewHost().appliedSurfaces();
  return alignmentOf(half, applied);
}

/** Every element at an address **a person can see**, with its box.
 *
 * A window holds more than the space in front of it: another space's panes are mounted with their
 * own rectangles, and a workspace that is not active keeps its whole plane. Counting those answers
 * questions about a layout nobody is looking at — measured 2026-08-17, the leftmost pane in the
 * window was one of them, sitting at x=5 through a motion in which every visible pane travelled from
 * 5 to 165, and every seam and overlap measured against it was a number about the wrong space.
 *
 * The address is the declaration a person can already read through `ui.tree`; this answers it beside
 * the surfaces so both are one instant. */
function boxesOf(selector: string): Array<{ node: string; box: Box }> {
  return Array.from(globalThis.document.querySelectorAll<HTMLElement>(selector))
    .filter((element) => onScreen(element))
    .map((element) => ({
      node: element.dataset.node ?? "",
      box: boxOf(element.getBoundingClientRect()),
    }));
}

/** Whether the document draws this element at all: nothing on the way up hides it, and the workspace
 *  plane it is in is the active one. */
function onScreen(element: HTMLElement): boolean {
  for (let at: HTMLElement | null = element; at; at = at.parentElement) {
    const style = at.ownerDocument.defaultView?.getComputedStyle(at);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
    if (at.hasAttribute("data-workspace-plane") && at.dataset.workspaceActive !== "1") return false;
  }
  return true;
}

/** The rectangle the last commit declared for this element, written back on the element by the
 *  observer. Null before the first commit, which is a different answer from a commit that declared
 *  a zero box. */
function declaredOf(element: HTMLElement): Box | null {
  const raw = element.dataset.nativeDeclaredFrame;
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}
