// @vitest-environment jsdom
// The pane plane on screen: every rect the space draws is the plane's, in px, through one CSS rule.
//
// Measured 2026-09-05 on the first build of the plane: the window came up blank with React error
// 185 (an update loop) in the restoring phase. The plane box was selected from its store as a fresh
// object on every render, so every render was a change.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupArea } from "./GroupArea";
import { parkedArrangement, useSessions, type Space } from "../state/sessions";
import { setPlaneBox } from "../state/planeBox";
import { standRail } from "../state/panePlane";
import { solveArrangement } from "../lib/railArrangement";
import { rowPlane } from "../test/planes";

vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => {} });

let host: HTMLDivElement;
let root: Root;

const pane = (id: string) => ({
  id,
  activeTabId: `${id}-tab`,
  tabs: [{ id: `${id}-tab`, kind: "plugin" as const, title: id, pluginId: "fixture", view: "content" }],
});

beforeEach(() => {
  setPlaneBox({ width: 1000, height: 600, gap: 10 });
  useSessions.setState({ workspaces: [], activeId: "" });
  useSessions.getState().bootstrapFirstWorkspace("/test/root");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("a space on the plane", () => {
  // Measured 2026-09-05 on restart: the first render comes before the plane box is measured, so a
  // plane of 0×0 draws the rail 0 wide, and the lighting exemption refused a width of 0 — the
  // whole window came up as BOOT_FAILURE in the restoring phase.
  it("renders before the plane is measured, with a rail on the plane", () => {
    setPlaneBox({ width: 0, height: 0, gap: 0 });
    const base = useSessions.getState().workspaces[0];
    const space: Space = {
      ...base.spaces[0],
      panes: [pane("pan-a"), pane("pan-b")],
      layout: standRail(rowPlane(["pan-a", "pan-b"]), { width: 1000, height: 600, gap: 0 }, 0, 320)!,
      activePaneId: "pan-a",
    };
    const workspace = { ...base, spaces: [space] };
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const arrangement = solveArrangement({
      layout: space.layout, box: { width: 0, height: 0, gap: 0 }, focusId: "pan-a",
      placement: { mode: "flow" }, railPresent: true,
    });
    expect(arrangement.rail).toMatchObject({ width: 0 });

    act(() => root.render(
      <GroupArea content={space} projectId={workspace.id} arrangement={arrangement} />,
    ));
    expect(host.querySelector(`[data-node="layout/space/${space.id}"]`)).not.toBeNull();
    expect(host.querySelector("[data-lighting-exempt]")).toBeNull();
  });

  it("draws each pane at the plane's px rect, and renders once for one solution", () => {
    const base = useSessions.getState().workspaces[0];
    const space: Space = {
      ...base.spaces[0],
      panes: [pane("pan-a"), pane("pan-b")],
      layout: rowPlane(["pan-a", "pan-b"]),
      activePaneId: "pan-a",
    };
    const workspace = { ...base, spaces: [space] };
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    const arrangement = parkedArrangement(space);

    const render = () => root.render(
      <GroupArea content={space} projectId={workspace.id} arrangement={arrangement} />,
    );
    act(render);
    act(render);

    const spaceEl = host.querySelector<HTMLElement>(`[data-node="layout/space/${space.id}"]`);
    expect(spaceEl).not.toBeNull();
    const a = host.querySelector<HTMLElement>('[data-node="layout/pane/pan-a"]')!;
    const b = host.querySelector<HTMLElement>('[data-node="layout/pane/pan-b"]')!;
    // Two panes side by side with a corridor of 10: 495 each, b at 505.
    expect(a.style.getPropertyValue("--l")).toBe("0px");
    expect(a.style.getPropertyValue("--w")).toBe("495px");
    expect(b.style.getPropertyValue("--l")).toBe("505px");
    expect(b.style.getPropertyValue("--h")).toBe("600px");
    // One divider, where the plane says the boundary is grabbed, named by the pane's edge.
    const gutter = host.querySelector<HTMLElement>('[data-node="gutter/pan-a/right"]')!;
    expect(gutter).not.toBeNull();
    expect(Number.parseFloat(gutter.style.left)).toBeLessThan(505);
    expect(Number.parseFloat(gutter.style.left) + Number.parseFloat(gutter.style.width)).toBeGreaterThan(495);
  });
});
