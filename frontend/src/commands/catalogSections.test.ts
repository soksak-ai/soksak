import { beforeEach, describe, expect, it } from "vitest";
import { refuseUnplaced } from "./catalogSections";
import { useViewRegistry } from "../plugins/viewRegistry";
import type { ViewPlacement } from "../plugins/spec";

// A set stands in a region only where its sections are placed.
//
// A set names no region — the link and the fixed choice settle that (A2a) — so the check runs where
// the region is settled. A section whose plugin placed it on the right cannot be drawn on the
// left, and dropping it there silently reads as the plugin failing rather than as the link being
// wrong. Nothing read this rule until 2026-08-16.
const view = (placements: ViewPlacement[]) => ({
  id: "tree",
  title: { en: "T", ko: "T" },
  icon: "|",
  placements,
  defaultPlacement: placements[0],
  transparent: false,
  nativeSurface: false,
  decoration: false,
});

const setOf = (...sections: string[]) => ({ id: "set-a", title: "work", sections });

describe("a set standing in a region", () => {
  beforeEach(() => {
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
  });

  it("stands when every section it holds is placed in that region", () => {
    useViewRegistry.getState().register("plg-a", view(["left"]), { mount: () => {} });
    expect(refuseUnplaced(setOf("plg-a.tree"), "left")).toBeNull();
  });

  it("names the section that is not placed there rather than dropping it", () => {
    useViewRegistry.getState().register("plg-a", view(["right"]), { mount: () => {} });
    const refusal = refuseUnplaced(setOf("plg-a.tree"), "left");
    expect(refusal).toContain("plg-a.tree");
    expect(refusal).toContain("left");
  });

  it("names a section whose plugin registered nothing", () => {
    expect(refuseUnplaced(setOf("plg-gone.tree"), "left")).toContain("plg-gone.tree");
  });

  it("names every unplaced section, not the first", () => {
    useViewRegistry.getState().register("plg-a", view(["left"]), { mount: () => {} });
    const refusal = refuseUnplaced(setOf("plg-a.tree", "plg-b.tree", "plg-c.tree"), "left");
    expect(refusal).toContain("plg-b.tree");
    expect(refusal).toContain("plg-c.tree");
  });
});
