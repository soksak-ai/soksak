// Where the light is, read off the plane as addresses and rectangles.
//
// The focus lighting is one plane outside the content: a base veil over everything, an aperture
// letting the focused pane through, cutouts, and regions exempted from the veil. Whether it dims
// the right pane is a visual question with a numeric answer — the aperture's address is the
// focused pane's — and reading it needs the plane's own addresses instead of a picture (L6).
//
// The plane is drawn by one component and never assembled from a guess: every node here has a
// data-node it wrote itself, so this reads and does not infer.

/** One region of the lighting plane. */
export interface LightingRegion {
  /** The address the plane wrote on it. */
  node: string;
  /** What the region covers — a pane id, or the name of an exempted band. */
  target: string;
  rect: { x: number; y: number; w: number; h: number };
}

/** The whole plane, as one answer. */
export interface LightingRegions {
  /** The space this plane is for, or null when no plane is drawn. */
  scope: string | null;
  /** The veil over everything. */
  base: LightingRegion | null;
  /** The hole the focused pane shows through. Null when nothing is focused, which is a real state. */
  aperture: LightingRegion | null;
  /** Holes for panes that are not the focused one. */
  cutouts: LightingRegion[];
  /** Bands the veil does not cover at all, such as the rail. */
  exempt: LightingRegion[];
  /** Panes dimmed harder because the rail could not reach the focused one. */
  blocked: LightingRegion[];
}

const PREFIX = "focus-lighting/";

function rectOf(el: Element): LightingRegion["rect"] {
  const box = el.getBoundingClientRect();
  return { x: box.left, y: box.top, w: box.width, h: box.height };
}

/**
 * Reads the lighting plane in one document.
 *
 * No plane is an empty answer rather than a missing one: a space with nothing focused draws none,
 * and a caller has to be able to tell that from a command that failed.
 */
export function lightingRegionsIn(root: Document | ParentNode): LightingRegions {
  const answer: LightingRegions = {
    scope: null, base: null, aperture: null, cutouts: [], exempt: [], blocked: [],
  };

  // Inside the active space, and nowhere else. A window holds one plane per space and a parked
  // space keeps both its DOM and its box, so no measurement separates them — the space plane
  // declares which one is on screen and this reads that declaration.
  //
  // It read whichever plane came first until 2026-08-19, on the premise that one screen holds one
  // plane. Measured that day on a running window: two planes, 999x757 each, and the answer named
  // the parked space with an aperture on a pane the arrangement had never heard of. Every reading
  // of the lighting was then about a space nobody was looking at, and all of them passed.
  //
  // No active plane is an empty answer, never a parked one: a window mid-switch draws none for a
  // frame, and a veil nobody is under is worse than no veil because it reads as one.
  const active = root.querySelector<HTMLElement>('[data-space-plane][data-space-active="1"]');
  const nodes = active
    ? [...active.querySelectorAll<HTMLElement>(`[data-node^="${PREFIX}"]`)]
    : [];
  for (const el of nodes) {
    const address = el.dataset.node ?? "";
    const path = address.slice(PREFIX.length);
    const [scope, kind, ...rest] = path.split("/");
    if (!scope) continue;
    answer.scope ??= scope;
    if (scope !== answer.scope) continue;

    const target = rest.join("/");
    const region: LightingRegion = { node: address, target, rect: rectOf(el) };
    switch (kind) {
      case undefined:
        break;
      case "base":
        answer.base = { ...region, target: scope };
        break;
      case "aperture":
        answer.aperture = region;
        break;
      case "cutout":
        answer.cutouts.push(region);
        break;
      case "exempt":
        answer.exempt.push(region);
        break;
      case "blocked":
        answer.blocked.push(region);
        break;
      // mask, mask/base and content are the plane's own scaffolding. They carry no decision a
      // caller judges, and listing them would put four entries beside every real one.
    }
  }
  return answer;
}
