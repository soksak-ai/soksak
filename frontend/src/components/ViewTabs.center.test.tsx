// The active tab is kept at the centre of the strip.
//
// A split or a merge changes the strip's width without changing which tab is active or how many
// there are. Centring only on those two facts left the active tab half outside the strip after a
// split — measured 2026-09-04.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewTabs } from "./ViewTabs";
import { allGroups, useSessions } from "../state/sessions";
import { splitLeaf } from "../state/splitTree";

// One observer per mount, and the test drives it. A real ResizeObserver never fires in jsdom, so a
// fixture that used one would pass whether or not the width is a reason to centre.
let resized: (() => void) | null = null;
vi.stubGlobal(
  "ResizeObserver",
  class {
    constructor(callback: () => void) {
      resized = callback;
    }
    observe() {}
    disconnect() {
      resized = null;
    }
  },
);

const scrolled: Array<{ left: number; behavior?: ScrollBehavior }> = [];
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: (options: { left: number; behavior?: ScrollBehavior }) => {
    scrolled.push(options);
  },
});

// jsdom lays nothing out: every rect is zero and every scroll extent is zero. The strip is given a
// width narrower than its content, and the active tab a position outside it, so a centring call has
// a target to compute and the assertion reads that target rather than zero.
function layOut(host: HTMLElement, activeLeft: number): void {
  const strip = host.querySelector<HTMLElement>(".tabs")!;
  Object.defineProperty(strip, "clientWidth", { configurable: true, value: 200 });
  Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 600 });
  strip.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
  const active = host.querySelector<HTMLElement>(".tab.active")!;
  active.getBoundingClientRect = () => ({ left: activeLeft, width: 100 }) as DOMRect;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  scrolled.length = 0;
  useSessions.setState({ workspaces: [], activeId: "" });
  useSessions.getState().bootstrapFirstWorkspace("/test/root");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(): void {
  const base = useSessions.getState().workspaces[0];
  const content = base.spaces[0];
  const viewId = "v-active";
  const group = {
    ...allGroups(content.layout)[0],
    activeTabId: viewId,
    tabs: [
      { id: "v-first", kind: "plugin" as const, title: "First", pluginId: "fixture", view: "content" },
      { id: viewId, kind: "plugin" as const, title: "Active", pluginId: "fixture", view: "content" },
    ],
  };
  const workspace = {
    ...base,
    spaces: [{ ...content, activePaneId: group.id, layout: splitLeaf(group) }],
  };
  useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
  act(() => {
    root.render(
      <ViewTabs projectId={workspace.id} group={group} onTabPointerDown={() => {}} />,
    );
  });
}

describe("the active tab follows the centre of the strip", () => {
  it("centres it when the strip's width changes, without animating", () => {
    render();
    layOut(host, 400);
    scrolled.length = 0;

    expect(resized).not.toBeNull();
    act(() => resized!());

    // 400 + 100/2 = 450 is the tab's centre in the strip; 200/2 = 100 puts it in the middle.
    expect(scrolled).toEqual([{ left: 350, behavior: "auto" }]);
  });

  it("clamps to the scrollable range rather than scrolling past the end", () => {
    render();
    layOut(host, 580);
    scrolled.length = 0;

    act(() => resized!());

    // 600 - 200 = 400 is the whole range; a target beyond it would leave empty space on screen.
    expect(scrolled).toEqual([{ left: 400, behavior: "auto" }]);
  });
});
