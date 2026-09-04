// @vitest-environment jsdom
// The + activates its pane, like every other click in it.
//
// It stopped the mousedown that activation travels on, so opening the program menu on an unfocused
// pane left the focus where it was: the clicked pane stayed dim and another pane stayed lit
// (measured 2026-09-04).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewTabs } from "./ViewTabs";
import { allGroups, useSessions } from "../state/sessions";
import { splitLeaf } from "../state/splitTree";
import { useProgramRegistry } from "../plugins/programRegistry";
import { startExecutor } from "../commands/executor";

vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => {} });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useSessions.setState({ workspaces: [], activeId: "" });
  useSessions.getState().bootstrapFirstWorkspace("/test/root");
  useProgramRegistry.setState({
    version: 1,
    programs: { "terminal-vision": { decl: { title: { en: "Vision", ko: "Vision" } } } },
    order: ["terminal-vision"],
  } as never);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the + on a pane's tab strip", () => {
  it("activates its own pane", async () => {
    const base = useSessions.getState().workspaces[0];
    const space = base.spaces[0];
    const first = { ...allGroups(space.layout)[0] };
    const second = { ...first, id: "pan-second", tabs: [...first.tabs] };
    const workspace = {
      ...base,
      spaces: [{
        ...space,
        activePaneId: first.id,
        layout: {
          type: "split" as const,
          id: "s-1",
          dir: "col" as const,
          sizes: [0.5, 0.5],
          children: [splitLeaf(first), splitLeaf(second)],
        },
      }],
    };
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    // Activation goes through the pane.activate command; without the catalog it answers
    // REGISTRY_EMPTY and nothing happens.
    startExecutor();

    act(() => {
      root.render(
        <ViewTabs projectId={workspace.id} group={second} onTabPointerDown={() => {}} />,
      );
    });
    act(() => {
      host.querySelector<HTMLButtonElement>(`[data-node="tab/view/${second.id}/add"]`)!.click();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      useSessions.getState().workspaces[0].spaces[0].activePaneId,
      "the pane whose + was clicked is the active one",
    ).toBe(second.id);
  });
});
