import { beforeEach, describe, expect, it } from "vitest";
import { refuseUnplaced } from "./catalogSections";
import { useViewRegistry } from "../plugins/viewRegistry";
import type { ViewSurface } from "../plugins/spec";

// A set holds sections that live beside the work.
//
// A set names no place — the link and the left choice settle that (A2a) — and all three places are
// beside the work, so there is one question here: is this a `side` view at all. A tab-only view put
// into a set would be dropped silently, which reads as the plugin failing rather than as the set
// being wrong. Nothing read this rule until 2026-08-16.
//
// It asked "is this section placed in that region" until 2026-08-18, when the window grew a third
// place and a view stopped naming one at all: no consumer had ever told left from right, and a view
// that named a place would be arranging the window from inside the plugin.
const view = (surfaces: ViewSurface[]) => ({
  id: "tree",
  title: { en: "T", ko: "T" },
  icon: "|",
  surfaces,
  transparent: false,
  nativeSurface: false,
  decoration: false,
});

const setOf = (...sections: string[]) => ({ id: "set-a", title: "work", sections });

describe("a set standing beside the work", () => {
  beforeEach(() => {
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
  });

  it("stands when every section it holds lives beside the work", () => {
    useViewRegistry.getState().register("plg-a", view(["side"]), { mount: () => {} });
    expect(refuseUnplaced(setOf("plg-a.tree"))).toBeNull();
  });

  it("names a section that lives on a tab rather than dropping it", () => {
    useViewRegistry.getState().register("plg-a", view(["tab"]), { mount: () => {} });
    expect(refuseUnplaced(setOf("plg-a.tree"))).toContain("plg-a.tree");
  });

  it("takes a section that lives on both", () => {
    useViewRegistry.getState().register("plg-a", view(["tab", "side"]), { mount: () => {} });
    expect(refuseUnplaced(setOf("plg-a.tree"))).toBeNull();
  });

  it("names a section whose plugin registered nothing", () => {
    expect(refuseUnplaced(setOf("plg-gone.tree"))).toContain("plg-gone.tree");
  });

  it("names every unplaced section, not the first", () => {
    useViewRegistry.getState().register("plg-a", view(["side"]), { mount: () => {} });
    const refusal = refuseUnplaced(setOf("plg-a.tree", "plg-b.tree", "plg-c.tree"));
    expect(refusal).toContain("plg-b.tree");
    expect(refusal).toContain("plg-c.tree");
  });
});
