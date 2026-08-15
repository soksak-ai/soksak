// @vitest-environment jsdom
// Where the light is, as an address rather than a look.
//
// The focus lighting is one plane outside the content: a base veil over everything, an aperture
// that lets the focused pane through, cutouts, and regions exempted from the veil. Whether it is
// dimming the right pane is a visual question with a numeric answer — the aperture's address is
// the focused pane's — and until this there was no way to ask it.
//
// The plane already writes an address on every region. What was missing is a command that reads
// them, so the only way to judge the lighting was to look at a picture (L6 forbids that).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
}));

import { lightingRegionsIn } from "./focusLighting";

/** Builds a lighting plane the way FocusLightingPlane draws one. */
function plane(scope: string, parts: Array<[string, DOMRectInit]>): HTMLElement {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  root.dataset.node = `focus-lighting/${scope}`;
  document.body.append(root);
  for (const [path, rect] of parts) {
    const el = document.createElement("div");
    el.dataset.node = `focus-lighting/${scope}/${path}`;
    el.getBoundingClientRect = () =>
      ({
        left: rect.x ?? 0, top: rect.y ?? 0, width: rect.width ?? 0, height: rect.height ?? 0,
        right: (rect.x ?? 0) + (rect.width ?? 0), bottom: (rect.y ?? 0) + (rect.height ?? 0),
        x: rect.x ?? 0, y: rect.y ?? 0, toJSON: () => rect,
      }) as DOMRect;
    root.append(el);
  }
  return root;
}

describe("the lighting regions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("names the aperture and what it is over", () => {
    plane("spc-a", [
      ["base", { x: 0, y: 0, width: 800, height: 600 }],
      ["mask", { x: 0, y: 0, width: 800, height: 600 }],
      ["mask/base", { x: 0, y: 0, width: 800, height: 600 }],
      ["aperture/pan-focused", { x: 100, y: 50, width: 300, height: 200 }],
    ]);
    const regions = lightingRegionsIn(document);
    expect(regions.scope).toBe("spc-a");
    expect(regions.aperture).toEqual({
      node: "focus-lighting/spc-a/aperture/pan-focused",
      target: "pan-focused",
      rect: { x: 100, y: 50, w: 300, h: 200 },
    });
  });

  it("names the base, the cutouts and the exemptions separately", () => {
    // Three different reasons a pixel is not dimmed. Folding them into one list makes a rail that
    // was exempted look like a pane that was cut out, and the two are decided by different rules.
    plane("spc-a", [
      ["base", { x: 0, y: 0, width: 800, height: 600 }],
      ["aperture/pan-a", { x: 0, y: 0, width: 10, height: 10 }],
      ["cutout/pan-b", { x: 20, y: 0, width: 10, height: 10 }],
      ["exempt/left-rail", { x: 40, y: 0, width: 10, height: 10 }],
      ["blocked/pan-c", { x: 60, y: 0, width: 10, height: 10 }],
    ]);
    const regions = lightingRegionsIn(document);
    expect(regions.base?.node).toBe("focus-lighting/spc-a/base");
    expect(regions.cutouts.map((r) => r.target)).toEqual(["pan-b"]);
    expect(regions.exempt.map((r) => r.target)).toEqual(["left-rail"]);
    expect(regions.blocked.map((r) => r.target)).toEqual(["pan-c"]);
  });

  it("no plane is an empty answer, not a missing one", () => {
    // A space with nothing focused draws no plane. Answering null for the whole shape would make a
    // caller unable to tell that from a command that failed.
    const regions = lightingRegionsIn(document);
    expect(regions.scope).toBeNull();
    expect(regions.aperture).toBeNull();
    expect(regions.cutouts).toEqual([]);
  });

  it("a plane with a veil and no aperture is reported as it stands", () => {
    // Every pane dimmed and none lit is a real state — nothing is focused. Inventing an aperture
    // would report a lit pane that is not there.
    plane("spc-a", [["base", { x: 0, y: 0, width: 800, height: 600 }]]);
    const regions = lightingRegionsIn(document);
    expect(regions.base).not.toBeNull();
    expect(regions.aperture).toBeNull();
  });
});
