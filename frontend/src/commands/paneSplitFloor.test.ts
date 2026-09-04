// A split that cannot be drawn is refused, not performed.
//
// The .pane rule in App.css takes --pane-inset off both edges of the cell. A cell narrower than the
// inset pair therefore has no interior: the browser clamps the negative width to 0 and the screen stops
// showing the tree. Measured 2026-08-16 in a 999px space, splitting the same pane repeatedly
// reached a declared cell of 0.11% — 1.1px — and layout.verify reported the pane 11.08px narrower than
// declared, which reads as a rendering defect rather than as a wall the layout ran into.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
  clear: () => mem.clear(),
});
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import { useSessions, type Pane, type Workspace } from "../state/sessions";
import { initialSidebarLayout } from "../state/sidebarLayout";
import { MIN_PANE_PX, singlePane, standRail } from "../state/panePlane";
import { planeBox, setPlaneBox } from "../state/planeBox";

const pane = (id: string): Pane => ({
  id,
  activeTabId: id.replace("pan-", "tab-"),
  tabs: [{ id: id.replace("pan-", "tab-"), kind: "plugin", title: id, pluginId: "fixture", view: "content" }],
});

function workspace(): Workspace {
  return {
    id: "wsp-aaaaaa",
    title: "P",
    root: "/tmp/floor",
    regionOpen: { left: false, rail: false, right: false },
    railPlacement: { mode: "flow" },
    sidebarLayouts: { left: initialSidebarLayout([]), rail: initialSidebarLayout([]), right: initialSidebarLayout([]) },
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        activePaneId: "pan-aaaaaa",
        panes: [pane("pan-aaaaaa")],
        layout: singlePane("pan-aaaaaa"),
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  };
}

/** The pane ids in the active space, in reading order. */
const paneIds = (): string[] =>
  useSessions.getState().workspaces[0].spaces[0].layout.cards
    .filter((card) => card.id !== "rail")
    .sort((a, b) => a.c0 - b.c0)
    .map((card) => card.id);

registerCatalog();

beforeEach(() => {
  vi.restoreAllMocks();
  useSessions.setState({ workspaces: [workspace()], activeId: "wsp-aaaaaa" });
});

// The plane refuses a split that would put a pane under its floor (split-pane minSize, which is
// MIN_PANE_PX: the two chrome bands and two bands of body). A refused split performs nothing.
describe("pane.split refuses a pane the plane cannot hold", () => {
  it("a plane wide enough to halve is split", async () => {
    setPlaneBox({ width: MIN_PANE_PX * 2, height: 600, gap: 0 });
    const result = await execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {});
    expect(result).toMatchObject({ ok: true });
    expect(paneIds()).toHaveLength(2);
  });

  it("a split whose halves would be under the floor is refused by name", async () => {
    setPlaneBox({ width: MIN_PANE_PX * 2 - 1, height: 600, gap: 0 });
    const result = await execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {});
    expect(result).toMatchObject({ ok: false, code: "TOO_SMALL" });
    // Refused means refused — the plane still holds one pane.
    expect(paneIds()).toEqual(["pan-aaaaaa"]);
  });

  it("the side decides which axis runs out", async () => {
    // Wide and short: a sideways split has room, a stacked one does not.
    setPlaneBox({ width: 800, height: MIN_PANE_PX * 2 - 1, gap: 0 });
    await expect(execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {}))
      .resolves.toMatchObject({ ok: true });
    useSessions.setState({ workspaces: [workspace()], activeId: "wsp-aaaaaa" });
    await expect(execute("pane.split", { pane: "pan-aaaaaa", side: "bottom", mountTimeoutMs: 0 }, {}))
      .resolves.toMatchObject({ ok: false, code: "TOO_SMALL" });
  });

  it("the corridor is room a pane does not get", async () => {
    // Two panes of exactly the floor fit with no corridor; a corridor of 10 leaves 5 short.
    setPlaneBox({ width: MIN_PANE_PX * 2, height: 600, gap: 10 });
    await expect(execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {}))
      .resolves.toMatchObject({ ok: false, code: "TOO_SMALL" });
  });

  it("the rail takes width from the row, and the floor counts it", async () => {
    // The rail is a card on the plane: its width is room the panes do not share.
    const base = workspace();
    const space = base.spaces[0];
    setPlaneBox({ width: MIN_PANE_PX * 2 + 60, height: 600, gap: 0 });
    useSessions.setState({
      workspaces: [{ ...base, spaces: [{ ...space, layout: standRail(space.layout, planeBox(), 0, 60)! }] }],
      activeId: "wsp-aaaaaa",
    });
    await expect(execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {}))
      .resolves.toMatchObject({ ok: true });

    useSessions.setState({
      workspaces: [{ ...base, spaces: [{ ...space, layout: standRail(space.layout, planeBox(), 0, 61)! }] }],
      activeId: "wsp-aaaaaa",
    });
    await expect(execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {}))
      .resolves.toMatchObject({ ok: false, code: "TOO_SMALL" });
  });
});
