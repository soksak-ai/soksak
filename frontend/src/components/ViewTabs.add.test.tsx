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
import { singlePane } from "../state/panePlane";
import { columnPlane } from "../test/planes";
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
  // A button takes focus when it is clicked. The terminal under it then loses focus, its cursor
  // changes and the pane reads as inactive — for a menu that was supposed to change nothing but
  // itself (measured 2026-09-04).
  it("does not take focus from what had it", () => {
    const base = useSessions.getState().workspaces[0];
    const space = base.spaces[0];
    const group = { ...allGroups(space)[0] };
    const workspace = {
      ...base,
      spaces: [{ ...space, activePaneId: group.id, panes: [group], layout: singlePane(group.id) }],
    };
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    startExecutor();

    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    act(() => {
      root.render(
        <ViewTabs projectId={workspace.id} group={group} active onTabPointerDown={() => {}} />,
      );
    });
    const add = host.querySelector<HTMLButtonElement>(`[data-node="tab/view/${group.id}/add"]`)!;
    act(() => {
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      const prevented = !add.dispatchEvent(down);
      // The browser moves focus on the default action of a mousedown. Refusing that action is what
      // keeps focus where it was.
      expect(prevented, "the + does not refuse the focus its mousedown would take").toBe(true);
    });
    elsewhere.remove();
  });

  const twoPanes = () => {
    const base = useSessions.getState().workspaces[0];
    const space = base.spaces[0];
    const first = { ...allGroups(space)[0] };
    const second = { ...first, id: "pan-second", tabs: [...first.tabs] };
    const workspace = {
      ...base,
      spaces: [{
        ...space,
        activePaneId: first.id,
        panes: [first, second],
        layout: columnPlane([first.id, second.id]),
      }],
    };
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    // Activation goes through the pane.activate command; without the catalog it answers
    // REGISTRY_EMPTY and nothing happens.
    startExecutor();
    return { workspace, first, second };
  };

  it("is inert on a pane that is not the active one", async () => {
    const { workspace, first, second } = twoPanes();
    act(() => {
      root.render(
        <ViewTabs projectId={workspace.id} group={second} active={false} onTabPointerDown={() => {}} />,
      );
    });
    const add = host.querySelector<HTMLButtonElement>(`[data-node="tab/view/${second.id}/add"]`)!;
    expect(add.disabled).toBe(true);
    act(() => { add.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(document.querySelector(".space-tab-menu"), "no menu opened").toBeNull();
    expect(useSessions.getState().workspaces[0].spaces[0].activePaneId).toBe(first.id);
  });

  it("on the active pane opens the menu and changes nothing else", async () => {
    const { workspace, first } = twoPanes();
    const before = JSON.stringify(useSessions.getState().workspaces);
    act(() => {
      root.render(
        <ViewTabs projectId={workspace.id} group={first} active onTabPointerDown={() => {}} />,
      );
    });
    const add = host.querySelector<HTMLButtonElement>(`[data-node="tab/view/${first.id}/add"]`)!;
    expect(add.disabled).toBe(false);
    act(() => { add.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(document.querySelector(".space-tab-menu"), "the menu is the only thing that appears").not.toBeNull();
    expect(JSON.stringify(useSessions.getState().workspaces)).toBe(before);
  });
});
