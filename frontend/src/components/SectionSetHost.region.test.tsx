// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SectionSetHost } from "./SectionSetHost";
import { LAYOUT_MOTION_MS } from "../lib/layoutMotion";
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
const OTHER_PLUGIN = "plg-b";

const view = (surfaces: ("side" | "tab")[]) => ({
  id: "tree",
  title: { en: "Files", ko: "Files" },
  icon: "|",
  surfaces,
  transparent: false,
  nativeSurface: false,
  decoration: false,
});

const workspace = (): Workspace =>
  ({
    id: "wsp-a1b2c3",
    sidebarLayouts: { left: initialSidebarLayout([]), rail: initialSidebarLayout([]), right: initialSidebarLayout([]) },
  }) as unknown as Workspace;

describe("a region draws the set standing in it", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
    useSectionSets.setState({ sets: [], byPlugin: {}, left: null });
    useSessions.setState({ workspaces: [workspace()], activeId: "wsp-a1b2c3" });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (
    region: "left" | "rail" | "right",
    focusedPluginId: string | null = PLUGIN,
  ) =>
    act(() => {
      root.render(
        <SectionSetHost
          region={region}
          workspace={useSessions.getState().workspaces[0]!}
          paneId=""
          focusedPluginId={focusedPluginId}
        />,
      );
    });

  /** A `side` section, in a set, linked to one of the two places a plugin fills. */
  const stand = (place: "rail" | "right") => {
    restores: "none" as const,
    useViewRegistry.getState().register(PLUGIN, view(["side"]), { restores: "none" as const, mount: () => {} });
    const set = useSectionSets.getState().create("work");
    useSectionSets.getState().arrange(set.id, [`${PLUGIN}.tree`]);
    useSectionSets.getState().link(PLUGIN, place, set.id);
    return set;
  };

  it("draws the linked section on the right", () => {
    stand("right");
    render("right");
    expect(host.textContent).toContain("Files");
  });

  it("mounts the active side provider rather than leaving only the section frame", async () => {
    useViewRegistry.getState().register(PLUGIN, view(["side"]), {
      restores: "none" as const,
      mount: (container) => container.append("mounted"),
    });
    const set = useSectionSets.getState().create("work");
    useSectionSets.getState().arrange(set.id, [`${PLUGIN}.tree`]);
    useSectionSets.getState().standLeft(set.id);
    render("left");
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("mounted");
  });

  it("gives every exposed node a unique address when one region has split panes", () => {
    restores: "none" as const,
    useViewRegistry.getState().register(PLUGIN, view(["side"]), { restores: "none" as const, mount: () => {} });
    restores: "none" as const,
    useViewRegistry.getState().register(OTHER_PLUGIN, view(["side"]), { restores: "none" as const, mount: () => {} });
    const set = useSectionSets.getState().create("work");
    const first = `${PLUGIN}.tree`;
    const second = `${OTHER_PLUGIN}.tree`;
    useSectionSets.getState().arrange(set.id, [first, second]);
    useSectionSets.getState().standLeft(set.id);

    const current = useSessions.getState().workspaces[0]!;
    useSessions.setState({
      workspaces: [{
        ...current,
        sidebarLayouts: {
          ...current.sidebarLayouts,
          left: {
            type: "split",
            id: "spl-sidebar",
            dir: "col",
            sizes: [0.4, 0.6],
            children: [
              { type: "leaf", value: { viewKeys: [first], activeViewKey: first } },
              { type: "leaf", value: { viewKeys: [second], activeViewKey: second } },
            ],
          },
        },
      }],
    });

    render("left");
    const addresses = [...host.querySelectorAll<HTMLElement>("[data-node]")]
      .map((node) => node.dataset.node);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("draws the linked section in the rail", () => {
    stand("rail");
    render("rail");
    expect(host.textContent).toContain("Files");
  });

  it("switches the standing rail set on the selected tab's plugin in the same render", () => {
    restores: "none" as const,
    useViewRegistry.getState().register(PLUGIN, view(["side"]), { restores: "none" as const, mount: () => {} });
    useViewRegistry.getState().register(
      OTHER_PLUGIN,
      { ...view(["side"]), title: { en: "Processes", ko: "Processes" } },
      { restores: "none" as const, mount: () => {} },
    );
    const files = useSectionSets.getState().create("files");
    const processes = useSectionSets.getState().create("processes");
    useSectionSets.getState().arrange(files.id, [`${PLUGIN}.tree`]);
    useSectionSets.getState().arrange(processes.id, [`${OTHER_PLUGIN}.tree`]);
    useSectionSets.getState().link(PLUGIN, "rail", files.id);
    useSectionSets.getState().link(OTHER_PLUGIN, "rail", processes.id);

    render("rail", PLUGIN);
    expect(host.textContent).toContain("Files");
    expect(host.textContent).not.toContain("Processes");

    render("rail", OTHER_PLUGIN);
    expect(host.textContent).not.toContain("Files");
    expect(host.textContent).toContain("Processes");
    expect(host.querySelector<HTMLElement>(".sidebar-body")?.dataset.regionStanding)
      .toBe(processes.id);
  });

  it("draws nothing in the place the link does not name", () => {
    // One `side` view, linked to one place. The view is standable in any of the three, so the
    // link is the only thing that settles it — and this would pass without the link being read at
    // all if the view were standable in one place only.
    stand("right");

    render("right");
    // Oracle liveness — the same section, the same set, drawn where the link names.
    expect(host.textContent).toContain("Files");

    render("rail");
    expect(host.textContent).not.toContain("Files");
  });

  it("the left edge draws what was stood there, and no link touches it", () => {
    restores: "none" as const,
    useViewRegistry.getState().register(PLUGIN, view(["side"]), { restores: "none" as const, mount: () => {} });
    const set = useSectionSets.getState().create("work");
    useSectionSets.getState().arrange(set.id, [`${PLUGIN}.tree`]);
    useSectionSets.getState().link(PLUGIN, "rail", set.id);

    // Linked to the rail and nothing stood on the left: the left is not a place a link names.
    render("left");
    expect(host.textContent).not.toContain("Files");

    act(() => useSectionSets.getState().standLeft(set.id));
    render("left");
    expect(host.textContent).toContain("Files");
  });

  // What leaves, leaves with the space it stood in. The region's width travels with the panes, so a
  // section that vanished in the render leaves an empty strip for the whole closing motion —
  // measured 2026-08-17, 160 points for 160ms. It is drawn until the space has closed, and then it
  // is gone.
  it("draws the section until the closing motion has taken its space, and nothing after", async () => {
    stand("right");
    render("right");
    // Oracle liveness — it is on screen before the link goes.
    expect(host.textContent).toContain("Files");

    act(() => useSectionSets.getState().link(PLUGIN, "right", null));
    render("right");
    expect(host.textContent).toContain("Files");

    await act(async () => {
      await new Promise((done) => setTimeout(done, LAYOUT_MOTION_MS + 40));
    });
    render("right");
    expect(host.textContent).not.toContain("Files");
  });
});
