import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewTabs } from "./ViewTabs";
import { allGroups, useSessions } from "../state/sessions";
import { singlePane } from "../state/panePlane";
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

describe("feature tab maximize", () => {
  // Double click now runs the tab.maximize **command** — UI and CLI/AI must take the same path
  // so the two do not diverge. This test therefore builds the catalog and waits for the command
  // to finish.
  it("a tab double click maximizes that feature view", async () => {
    const base = useSessions.getState().workspaces[0];
    const content = base.spaces[0];
    const viewId = "v-max";
    const group = {
      ...allGroups(content)[0],
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
    const workspace = {
      ...base,
      spaces: [{ ...content, activePaneId: group.id, panes: [group], layout: singlePane(group.id) }],
    };
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    startExecutor(); // The command catalog — without it the command answers REGISTRY_EMPTY and nothing happens.

    act(() => {
      root.render(
        <ViewTabs
          projectId={workspace.id}
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
      useSessions.getState().workspaces[0].spaces[0].maximizedTabId,
    ).toBe(viewId);
  });
});
