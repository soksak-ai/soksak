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
    // One divider, where the plane puts the grab area, named by the pane's edge.
    const gutter = host.querySelector<HTMLElement>('[data-node="gutter/pan-a/right"]')!;
    expect(gutter).not.toBeNull();
    expect(Number.parseFloat(gutter.style.left)).toBeLessThan(505);
    expect(Number.parseFloat(gutter.style.left) + Number.parseFloat(gutter.style.width)).toBeGreaterThan(495);
  });
});

describe("what a covered pane declares to the compositor", () => {
  // A native surface is composited above the document, so an overlay over a pane is shown by taking
  // the surface off and drawing its picture in its place. The compositor folds `data-surface-visible`
  // on any ancestor of the declaration, so the tab body's attribute is the hide: it must fall only
  // once the picture is on screen. Measured 2026-09-05 with window.burst: the attribute fell on the
  // render that opened the + menu, and the pane was white for three frames (709–749ms) before the
  // picture was drawn.
  it("keeps the surface presented until the picture stands in, then hides it", async () => {
    const { useUi } = await import("../state/ui");
    const { __resetParkedPicturesForTest, __setParkedPictureForTest, markParkedPictureShown } = await import("../lib/parkedPicture");
    __resetParkedPicturesForTest();
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
    // The plane's rects, which jsdom does not lay out.
    const rectOf = (left: number, right: number) => () =>
      ({ left, top: 0, right, bottom: 600, width: right - left, height: 600, x: left, y: 0, toJSON() {} }) as DOMRect;
    host.querySelector<HTMLElement>('[data-node="layout/pane/pan-a"]')!.getBoundingClientRect = rectOf(0, 495);
    host.querySelector<HTMLElement>('[data-node="layout/pane/pan-b"]')!.getBoundingClientRect = rectOf(505, 1000);
    const presented = (view: string) =>
      host.querySelector<HTMLElement>(`[data-node="layout/tab/${view}"]`)!.dataset.surfaceVisible;

    // A menu over 200×150 of pane a.
    act(() => useUi.getState().pushOverlay(true, { left: 100, top: 50, right: 300, bottom: 200 }));
    expect(presented("pan-a-tab")).toBe("true");
    expect(presented("pan-b-tab")).toBe("true");

    // The picture is held: still not on screen, still presented.
    act(() => __setParkedPictureForTest("pan-a-tab", "data:image/png;base64,iVBORw0KGgo="));
    expect(presented("pan-a-tab")).toBe("true");

    // Drawn: now the surface steps aside.
    act(() => markParkedPictureShown("pan-a-tab"));
    expect(presented("pan-a-tab")).toBe("false");
    expect(presented("pan-b-tab")).toBe("true");

    // The menu closes: the surface is presented again at once; the picture goes when it is back.
    act(() => useUi.getState().popOverlay(true, { left: 100, top: 50, right: 300, bottom: 200 }));
    expect(presented("pan-a-tab")).toBe("true");
    __resetParkedPicturesForTest();
  });
});
