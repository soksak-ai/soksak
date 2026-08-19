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
  /** Raw native layout frame when presentation is transformed during an interactive phase. */
  settled: Box | null;
  visible: boolean;
  /** dom vs declared — how far the declaration has fallen behind the element. */
  lag: number | null;
  /** declared vs applied — what the native layer did with what it was given. */
  drift: number | null;
  /** dom vs applied — the whole distance between a pane and the page drawn for it. */
  off: number | null;
}

/** One section standing in a region, under the key that names whose it is. */
export interface StandingSection {
  /** left or right. */
  region: string;
  /** `<pluginId>.<viewId>` — the plugin is the half a region's width cannot state. */
  section: string;
}

export interface LayoutAlignment {
  regions: Array<{ region: string } & Box>;
  /** What is on the screen in each region. A region has a width whoever put a section in it:
   *  measured 2026-08-17, a browser was focused, the region stood, and the file tree was in it. */
  sections: StandingSection[];
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
  sections: LayoutAlignment["sections"];
  panes: LayoutAlignment["panes"];
  frames: LayoutAlignment["frames"];
  boundaries: LayoutAlignment["boundaries"];
  declarations: Array<{ id: string; dom: Box; declared: Box | null }>;
} {
  // Read from what each place declares about itself. The names were paired with node paths by hand
  // until 2026-08-18 — two places, two selectors, and the rail answered "left" because that is what
  // it had been called. A place added then had no box here at all.
  const regions = boxesOf("[data-region]").map((box) => ({
    region: box.region ?? "",
    ...box.box,
  }));
  // Whose sections are on the screen, in the region they are in. The hidden one of a stack is
  // mounted with no box, so a section is counted by what it occupies rather than by what exists.
  const sections = boxesOf("[data-node^='section/']")
    .filter((box) => box.box.w > 0 && box.box.h > 0)
    .map((box) => {
      const parts = box.node.split("/");
      return { region: parts[1] ?? "", section: parts.slice(2).join("/") };
    });
  // Every pane on the screen, whoever is drawing it.
  //
  // A travel takes the core's pane chrome away and gives the coordinates to the travelling
  // object (lib/viewTravelPresentation), so mid-motion the pane elements of the panes that
  // move are not in the document at all. A reading built on them alone answers one pane
  // where a person sees three — measured 2026-08-17 through one travel, and two verdicts
  // in this repository were drawn from that answer before anyone asked what it was made of.
  //
  // The outline around each pane is a separate element and it travels with the pane, so it
  // is what the reading falls back to. One shape either way: nothing here marks which of the two
  // two answered, because a caller that has to ask is a caller holding two readings.
  const drawn = boxesOf("[data-node*='layout/pane/']").map((box) => ({
    pane: box.node.slice(box.node.lastIndexOf("/") + 1),
    ...box.box,
  }));
  const frames = boxesOf("[data-node^='layout/frame/']").map((box) => ({
    pane: box.node.slice(box.node.lastIndexOf("/") + 1),
    ...box.box,
  }));
  const held = new Set(drawn.map((pane) => pane.pane));
  const panes = [...drawn, ...frames.filter((frame) => !held.has(frame.pane))];
  const boundaries = boxesOf("[data-node^='layout/focus-boundary/']").map((box) => ({
    pane: box.node.slice(box.node.lastIndexOf("/") + 1),
    ...box.box,
  }));
  const declarations = nativeSurfaceDeclarations().map((element) => ({
    id: element.dataset.nativeSurfaceId ?? "",
    dom: boxOf(element.getBoundingClientRect()),
    declared: declaredOf(element),
  }));
  return { regions, sections, panes, frames, boundaries, declarations };
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
    const settledBox = held?.settled
      ? {
          x: rounded(held.settled.x),
          y: rounded(held.settled.y),
          w: rounded(held.settled.w),
          h: rounded(held.settled.h),
        }
      : null;
    return {
      id: declaration.id,
      dom: declaration.dom,
      declared: declaration.declared,
      applied: appliedBox,
      settled: settledBox,
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
    sections: document.sections,
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
function boxesOf(selector: string): Array<{ node: string; region?: string; box: Box }> {
  return Array.from(globalThis.document.querySelectorAll<HTMLElement>(selector))
    .filter((element) => onScreen(element))
    .map((element) => ({
      node: element.dataset.node ?? "",
      region: element.dataset.region,
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
