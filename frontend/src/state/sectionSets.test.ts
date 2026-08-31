import { beforeEach, describe, expect, it } from "vitest";

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
describe("section sets — who stands where", () => {
  beforeEach(async () => {
    const { useSectionSets } = await load();
    useSectionSets.setState({ sets: [], byPlugin: {}, left: null });
  });

  const load = () => import("./sectionSets");

  it("stands the set linked to the focused plugin, and nothing for a plugin with no link", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().arrange(set.id, ["soksak-plugin-file-tree.tree"]);
    m.useSectionSets.getState().link("plg-a", "rail", set.id);

    expect(m.standingSet("rail", "plg-a")?.sections).toEqual(["soksak-plugin-file-tree.tree"]);
    // The link is one plugin's. Another plugin standing the same set would make the link decorative.
    expect(m.standingSet("rail", "plg-b")).toBeNull();
    expect(m.standingSet("rail", null)).toBeNull();
  });

  it("stands in the region the link names and in no other", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().arrange(set.id, ["plugin.view"]);
    m.useSectionSets.getState().link("plg-a", "right", set.id);

    expect(m.standingSet("right", "plg-a")?.id).toBe(set.id);
    // Reserving the other region's width for a set that does not stand there is a hole on screen.
    expect(m.standingSet("rail", "plg-a")).toBeNull();
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
    store.link("plg-a", "rail", files.id);
    store.link("plg-a", "right", tools.id);

    expect(m.standingSet("rail", "plg-a")?.id).toBe(files.id);
    expect(m.standingSet("right", "plg-a")?.id).toBe(tools.id);
  });

  it("clears one region and leaves the other standing", async () => {
    const m = await load();
    const store = m.useSectionSets.getState();
    const files = store.create("files");
    const tools = store.create("tools");
    store.link("plg-a", "rail", files.id);
    store.link("plg-a", "right", tools.id);
    store.link("plg-a", "right", null);

    expect(m.standingSet("right", "plg-a")).toBeNull();
    expect(m.standingSet("rail", "plg-a")?.id).toBe(files.id);
  });

  // The place is the rule, and there is no switch between the two. A switch let two places answer
  // the same way — the rail and a fixed sidebar both standing one set whatever was focused — and
  // then there was no reason for there to be two of them.
  it("the left edge stands one set whatever is focused", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().standLeft(set.id);

    expect(m.standingSet("left", "plg-a")?.id).toBe(set.id);
    expect(m.standingSet("left", "plg-b")?.id).toBe(set.id);
    expect(m.standingSet("left", null)?.id).toBe(set.id);
  });

  it("a plugin's link says nothing about the left edge", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().link("plg-a", "rail", set.id);

    // Oracle liveness — the same set stands in the rail for the plugin that linked it.
    expect(m.standingSet("rail", "plg-a")?.id).toBe(set.id);
    expect(m.standingSet("left", "plg-a")).toBeNull();
  });

  it("the left edge holds one set, and standing another replaces it", async () => {
    const m = await load();
    const files = m.useSectionSets.getState().create("files");
    const tools = m.useSectionSets.getState().create("tools");
    m.useSectionSets.getState().standLeft(files.id);
    m.useSectionSets.getState().standLeft(tools.id);

    expect(m.standingSet("left", null)?.id).toBe(tools.id);
    m.useSectionSets.getState().standLeft(null);
    expect(m.standingSet("left", null)).toBeNull();
  });

  // A place open with nothing in it reserves its width and draws nothing, which reads as a view
  // that failed to draw. The rail asked this and the right did not until 2026-08-17.
  it("a place is present only when it is open and a set stands there", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().arrange(set.id, ["plugin.view"]);
    m.useSectionSets.getState().link("plg-a", "right", set.id);

    expect(m.placePresent(true, "right", "plg-a")).toBe(true);
    // Open, and nothing stands: no width for a place a person cannot see anything in.
    expect(m.placePresent(true, "left", "plg-a")).toBe(false);
    expect(m.placePresent(true, "rail", "plg-a")).toBe(false);
    expect(m.placePresent(true, "right", "plg-b")).toBe(false);
    // Standing, and the person closed it.
    expect(m.placePresent(false, "right", "plg-a")).toBe(false);
  });

  it("does not reserve a place for an empty set", async () => {
    const m = await load();
    const empty = m.useSectionSets.getState().create("empty");
    m.useSectionSets.getState().link("plg-a", "rail", empty.id);

    expect(m.standingSet("rail", "plg-a")?.sections).toEqual([]);
    expect(m.placePresent(true, "rail", "plg-a")).toBe(false);
  });

  it("removing a set takes its links with it", async () => {
    const m = await load();
    const set = m.useSectionSets.getState().create("work");
    m.useSectionSets.getState().link("plg-a", "rail", set.id);
    m.useSectionSets.getState().standLeft(set.id);

    m.useSectionSets.getState().remove(set.id);

    // A link left behind names nothing: the plugin reads as linked while nothing stands.
    expect(m.useSectionSets.getState().byPlugin["plg-a"]).toBeUndefined();
    expect(m.useSectionSets.getState().left).toBeNull();
    expect(m.standingSet("rail", "plg-a")).toBeNull();
    expect(m.standingSet("left", null)).toBeNull();
  });
});
