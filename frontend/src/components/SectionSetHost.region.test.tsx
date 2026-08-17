// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SectionSetHost } from "./SectionSetHost";
import { useSectionSets } from "../state/sectionSets";

// React refuses to treat act() as a test boundary without it, and prints that on every render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { useViewRegistry } from "../plugins/viewRegistry";
import { useSessions, type Workspace } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";

// Both regions draw the set standing in them.
//
// The right region held a single active view and an icon rail of every view placed there. Measured
// on the running build 2026-08-16: `sections.link ... region=right` answered OK and the screen never
// changed, and removing the link again changed nothing either — the region read neither. A2a states
// that a region is a place and the workspace arranges what stands in it, and the rule was the left's
// alone.
//
// One host, one rule, a region as an argument.
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

const PLUGIN = "plg-a";

const view = (placements: ("left" | "right" | "center")[]) => ({
  id: "tree",
  title: { en: "Files", ko: "Files" },
  icon: "|",
  placements,
  defaultPlacement: placements[0],
  transparent: false,
  nativeSurface: false,
  decoration: false,
});

const workspace = (): Workspace =>
  ({
    id: "wsp-a1b2c3",
    sidebarLayouts: { left: initialSidebarLayout([]), right: initialSidebarLayout([]) },
  }) as unknown as Workspace;

describe("a region draws the set standing in it", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
    useSectionSets.setState({ sets: [], byPlugin: {}, mode: "individual", fixed: {} });
    useSessions.setState({ workspaces: [workspace()], activeId: "wsp-a1b2c3" });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (region: "left" | "right") =>
    act(() => {
      root.render(
        <SectionSetHost
          region={region}
          workspace={useSessions.getState().workspaces[0]!}
          paneId=""
          focusedPluginId={PLUGIN}
        />,
      );
    });

  const stand = (region: "left" | "right") => {
    useViewRegistry.getState().register(PLUGIN, view([region]), { mount: () => {} });
    const set = useSectionSets.getState().create("work");
    useSectionSets.getState().arrange(set.id, [`${PLUGIN}.tree`]);
    useSectionSets.getState().link(PLUGIN, region, set.id);
    return set;
  };

  it("draws the linked section on the right", () => {
    stand("right");
    render("right");
    expect(host.textContent).toContain("Files");
  });

  it("draws the linked section on the left", () => {
    stand("left");
    render("left");
    expect(host.textContent).toContain("Files");
  });

  it("draws nothing in the region the link does not name", () => {
    // Placed in both regions, linked to one. Anything less and the placement filter alone would drop
    // the section, and this would pass without the link's region being read at all.
    useViewRegistry.getState().register(PLUGIN, view(["left", "right"]), { mount: () => {} });
    const set = useSectionSets.getState().create("work");
    useSectionSets.getState().arrange(set.id, [`${PLUGIN}.tree`]);
    useSectionSets.getState().link(PLUGIN, "right", set.id);

    render("right");
    // Oracle liveness — the same section, the same set, drawn where the link names.
    expect(host.textContent).toContain("Files");

    render("left");
    expect(host.textContent).not.toContain("Files");
  });

  it("draws nothing once the link is removed", () => {
    stand("right");
    render("right");
    // Oracle liveness — it is on screen before the link goes.
    expect(host.textContent).toContain("Files");

    act(() => useSectionSets.getState().link(PLUGIN, "right", null));
    render("right");

    expect(host.textContent).not.toContain("Files");
  });
});
