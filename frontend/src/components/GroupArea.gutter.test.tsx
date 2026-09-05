// @vitest-environment jsdom
// A gutter drag stages every native surface's next rectangle before the document lays it out, and
// ends the stage once the document has. The compositor's observer holds the staged rectangles
// until this component reports the layout published; a stage that is never ended holds the
// surface at the staged rectangle through every later layout.
//
// Measured 2026-09-05 in a three-pane window: after one gutter drag the surfaces stood at the
// staged rectangles (366.51 wide 160.26) while the elements declaring them were laid out at
// 366.5 wide 160; a pane.resize after it moved the elements to 273 and the surfaces did not move.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  const calls: Array<{ call: "stage" | "release"; boundary: number | null }> = [];
  return {
    calls,
    boundaryNow: (): number | null => null,
    stage: vi.fn(async () => {
      calls.push({ call: "stage", boundary: native.boundaryNow() });
      return { sequence: 1, ids: [] as string[] };
    }),
    release: vi.fn(() => {
      calls.push({ call: "release", boundary: native.boundaryNow() });
    }),
  };
});
vi.mock("../framework/wails/nativeSurfaces", () => ({
  stageNativeSurfaceGeometry: native.stage,
  releaseNativeSurfaceGeometry: native.release,
}));

import { GroupArea } from "./GroupArea";
import { parkedArrangement, useSessions, type Space } from "../state/sessions";
import { setPlaneBox } from "../state/planeBox";
import { rectsOf } from "../state/panePlane";
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
  native.calls.length = 0;
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

describe("a gutter drag over native surfaces", () => {
  it("stages the next rectangles, and ends the stage once the boundary is in the document", async () => {
    const base = useSessions.getState().workspaces[0];
    const space: Space = {
      ...base.spaces[0],
      panes: [pane("pan-a"), pane("pan-b")],
      layout: rowPlane(["pan-a", "pan-b"]),
      activePaneId: "pan-a",
    };
    const workspace = { ...base, spaces: [space] };
    useSessions.setState({ workspaces: [workspace], activeId: workspace.id });
    // The boundary between the two panes, in px: the left pane's right edge plus half the corridor.
    native.boundaryNow = () => {
      const current = useSessions.getState().workspaces[0].spaces[0].layout;
      const left = rectsOf(current, { width: 1000, height: 600, gap: 10 }).get("pan-a");
      return left ? left.x + left.w + 5 : null;
    };

    act(() => root.render(
      <GroupArea content={space} projectId={workspace.id} arrangement={parkedArrangement(space)} />,
    ));
    // A plugin declares a native surface inside the left pane.
    const paneA = host.querySelector<HTMLElement>('[data-node="layout/pane/pan-a"]')!;
    const surface = document.createElement("div");
    surface.dataset.nativeSurface = "terminal";
    surface.dataset.nativeSurfaceId = "terminal.pan-a";
    paneA.append(surface);

    const gutter = host.querySelector<HTMLElement>('[data-node="gutter/pan-a/right"]')!;
    act(() => {
      gutter.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500, clientY: 100 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 540, clientY: 100 }));
    });
    await vi.waitFor(() => expect(native.stage).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup", { clientX: 540, clientY: 100 }));
    });
    await vi.waitFor(() => expect(native.release).toHaveBeenCalled());

    // Staged with the boundary still where the drag began; released once it is at the pointer.
    expect(native.calls.map((c) => c.call)).toEqual(["stage", "release"]);
    expect(native.calls[0].boundary).toBe(500);
    expect(native.calls[1].boundary).toBe(540);
  });
});
