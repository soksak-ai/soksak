import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewTabs } from "./ViewTabs";
import { allGroups, useSessions } from "../state/sessions";
import { splitLeaf } from "../state/splitTree";
import { startExecutor } from "../commands/executor";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: () => {},
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useSessions.setState({ projects: [], activeId: "" });
  useSessions.getState().bootstrapFirstProject("/test/root");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("feature tab maximize", () => {
  // Double click now runs the tab.maximize **command** — UI and CLI/AI must take the same path
  // so the two do not diverge. This test therefore builds the catalog and waits for the command
  // to finish.
  it("a tab double click maximizes that feature view", async () => {
    const base = useSessions.getState().projects[0];
    const content = base.spaces[0];
    const viewId = "v-max";
    const group = {
      ...allGroups(content.layout)[0],
      activeTabId: viewId,
      tabs: [
        {
          id: viewId,
          kind: "plugin" as const,
          title: "Feature",
          pluginId: "fixture",
          view: "content",
        },
      ],
    };
    const project = {
      ...base,
      spaces: [{ ...content, activePaneId: group.id, layout: splitLeaf(group) }],
    };
    useSessions.setState({ projects: [project], activeId: project.id });
    startExecutor(); // The command catalog — without it the command answers REGISTRY_EMPTY and nothing happens.

    act(() => {
      root.render(
        <ViewTabs
          projectId={project.id}
          group={group}
          onTabPointerDown={() => {}}
        />,
      );
    });
    act(() => {
      host.querySelector(".tab")!.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true }),
      );
    });

    // The command is async — drain the microtasks first, then measure the facts.
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      useSessions.getState().projects[0].spaces[0].maximizedTabId,
    ).toBe(viewId);
  });
});
