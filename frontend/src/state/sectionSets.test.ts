import { beforeEach, describe, expect, it, vi } from "vitest";

// Which set stands, and what a link costs when its set is gone.
//
// The sidebar is composed by a person: sections go into a set, and a set is given to a plugin
// (A2a). Nothing in this file was read by a test until 2026-08-16 — the composer, the link and the
// standing rule were 166 lines that no gate touched, while the screen depended on all three.
//
// What is worth a gate here is not that a setter sets. It is that a link points at a set that
// exists, that removing a set takes its links with it, and that a region draws only the set standing
// in it — each of those failing shows on screen as a sidebar that is empty, wrong, or reserved for
// nothing.
const BAG_KEY = "__soksakModuleState";

describe("section sets — who stands where", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  const load = () => import("./sectionSets");

  it("stands the set linked to the focused plugin, and nothing for a plugin with no link", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().arrange(set.id, ["soksak-plugin-file-tree.tree"]);
    m.useSectionSets.getState().link("plg-a", "left", set.id);

    expect(m.standingSet("left", "plg-a")?.sections).toEqual(["soksak-plugin-file-tree.tree"]);
    // The link is one plugin's. Another plugin standing the same set would make the link decorative.
    expect(m.standingSet("left", "plg-b")).toBeNull();
    expect(m.standingSet("left", null)).toBeNull();
  });

  it("stands in the region the link names and in no other", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().link("plg-a", "right", set.id);

    expect(m.standingSet("right", "plg-a")?.id).toBe(set.id);
    // Reserving the other region's width for a set that does not stand there is a hole on screen.
    expect(m.standingSet("left", "plg-a")).toBeNull();
  });

  // Two regions, and a plugin that wants both. A standing that names one region for the whole
  // plugin makes the second button unreachable: measured 2026-08-17 on the running build, the right
  // toggle answered OK and no width was ever taken, because the set stood on the left and one
  // plugin could only stand one.
  it("stands a set in each region for the same plugin", async () => {
    const m = await load();
    const store = m.useSectionSets.getState();
    const files = store.create("files");
    const tools = store.create("tools");
    store.link("plg-a", "left", files.id);
    store.link("plg-a", "right", tools.id);

    expect(m.standingSet("left", "plg-a")?.id).toBe(files.id);
    expect(m.standingSet("right", "plg-a")?.id).toBe(tools.id);
  });

  it("clears one region and leaves the other standing", async () => {
    const m = await load();
    const store = m.useSectionSets.getState();
    const files = store.create("files");
    const tools = store.create("tools");
    store.link("plg-a", "left", files.id);
    store.link("plg-a", "right", tools.id);
    store.link("plg-a", "right", null);

    expect(m.standingSet("right", "plg-a")).toBeNull();
    expect(m.standingSet("left", "plg-a")?.id).toBe(files.id);
  });

  it("in fixed the focused plugin decides nothing", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().link("plg-a", "left", set.id);
    m.useSectionSets.getState().setMode("fixed");
    m.useSectionSets.getState().setFixed("left", set.id);

    // Oracle liveness — the individual link above would answer for plg-a either way.
    expect(m.standingSet("left", "plg-b")?.id).toBe(set.id);
    expect(m.standingSet("left", null)?.id).toBe(set.id);
  });

  it("in fixed with none chosen nothing stands, whatever the links say", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().link("plg-a", "left", set.id);
    m.useSectionSets.getState().setMode("fixed");

    expect(m.standingSet("left", "plg-a")).toBeNull();
  });

  // A region open with nothing in it reserves its width and draws nothing, which reads as a view
  // that failed to draw. The left asked this and the right did not until 2026-08-17.
  it("a region is present only when it is open and a set stands there", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().link("plg-a", "right", set.id);

    expect(m.regionPresent(true, "right", "plg-a")).toBe(true);
    // Open, and nothing stands: no width for a region a person cannot see anything in.
    expect(m.regionPresent(true, "left", "plg-a")).toBe(false);
    expect(m.regionPresent(true, "right", "plg-b")).toBe(false);
    // Standing, and the person closed it.
    expect(m.regionPresent(false, "right", "plg-a")).toBe(false);
  });

  it("removing a set takes its links with it", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().link("plg-a", "left", set.id);
    m.useSectionSets.getState().setFixed("left", set.id);

    m.useSectionSets.getState().remove(set.id);

    // A link left behind names nothing: the plugin reads as linked while nothing stands.
    expect(m.useSectionSets.getState().byPlugin["plg-a"]).toBeUndefined();
    expect(m.useSectionSets.getState().fixed).toEqual({});
    expect(m.standingSet("left", "plg-a")).toBeNull();
  });
});
