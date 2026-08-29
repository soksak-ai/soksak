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
import { leavesOf, splitLeaf } from "../state/splitTree";

const INSET = 4;

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
        layout: splitLeaf(pane("pan-aaaaaa")),
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  };
}

/**
 * Puts the space box on screen at the given size, with the inset the .pane rule consumes.
 *
 * railWidthPx is what the rail takes out of the row. It is put on the pane the same way it is in
 * the app: as --rail-dw on the pane element, which is the cell's share of the rail width.
 */
function onScreen(width: number, height: number, options: { railWidthPx?: number } = {}): void {
  document.body.innerHTML = "";
  const space = document.createElement("div");
  space.dataset.node = "layout/space/spc-aaaaaa";
  space.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.append(space);

  const rail = options.railWidthPx ?? 0;
  const vars = new Map<Element, Record<string, string>>();
  vars.set(space, { "--pane-inset": `${INSET}px` });
  for (const id of leavesOf(useSessions.getState().workspaces[0].spaces[0].layout).map((p) => p.id)) {
    const pane = document.createElement("div");
    pane.dataset.node = `layout/pane/${id}`;
    pane.dataset.pane = id;
    // One pane holding the whole row, which is the fixture. Its share of the rail is all of it.
    vars.set(pane, { "--pane-inset": `${INSET}px`, "--rail-dw": `${-rail}px` });
    space.append(pane);
  }
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    ((el: Element): CSSStyleDeclaration =>
      ({ getPropertyValue: (name: string) => vars.get(el)?.[name] ?? "" }) as CSSStyleDeclaration),
  );
}

/** The pane ids in the active space, left to right. */
function paneIds(): string[] {
  return leavesOf(useSessions.getState().workspaces[0].spaces[0].layout).map((p) => p.id);
}

registerCatalog();

beforeEach(() => {
  vi.restoreAllMocks();
  useSessions.setState({ workspaces: [workspace()], activeId: "wsp-aaaaaa" });
});

describe("pane.split refuses a cell it cannot draw", () => {
  it("a space wide enough to halve is split", async () => {
    // Two cells of 400; the inset pair of 8 leaves 392 of interior each.
    onScreen(800, 600);
    const result = await execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {});
    expect(result).toMatchObject({ ok: true });
  });

  it("a split whose halves would have no interior is refused by name", async () => {
    // Two cells of 8, which is exactly the inset pair: nothing is left to draw.
    onScreen(16, 600);
    const result = await execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {});
    expect(result).toMatchObject({ ok: false, code: "TOO_SMALL" });
    expect(String((result as { message?: string }).message)).toMatch(/8/);
    // Refused means refused — the tree still holds one pane.
    expect(paneIds()).toEqual(["pan-aaaaaa"]);
  });

  it("the side decides which axis runs out", async () => {
    // Wide and short: a sideways split has room, a stacked one does not.
    onScreen(800, 16);
    await expect(execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {}))
      .resolves.toMatchObject({ ok: true });
    useSessions.setState({ workspaces: [workspace()], activeId: "wsp-aaaaaa" });
    onScreen(800, 16);
    await expect(execute("pane.split", { pane: "pan-aaaaaa", side: "bottom", mountTimeoutMs: 0 }, {}))
      .resolves.toMatchObject({ ok: false, code: "TOO_SMALL" });
  });

  it("the sibling squeezed by the split is what stops it, not the pane being split", async () => {
    // A split inserts a sibling and equalSizes redistributes the row, so the cell that runs out of room
    // is one nobody named. Measured 2026-08-16: a floor that read only the target let a 999px space
    // reach panes declared at 0.2% and drawn at 0.
    onScreen(100, 600);
    const grown: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const target = paneIds()[0];
      const result = await execute("pane.split", { pane: target, side: "right", mountTimeoutMs: 0 }, {});
      if (!result.ok) {
        expect(result).toMatchObject({ code: "TOO_SMALL" });
        break;
      }
      grown.push(target);
    }
    // 100px across an inset pair of 8 holds 12 cells and refuses the 13th.
    expect(paneIds()).toHaveLength(12);
    expect(await execute("pane.split", { pane: paneIds()[0], side: "right", mountTimeoutMs: 0 }, {}))
      .toMatchObject({ ok: false, code: "TOO_SMALL" });
  });

  it("the rail takes width from the row, and the floor counts it", async () => {
    // The rail is inserted into the row, so every cell keeps its percentage and loses pixels. A
    // floor computed from the space box alone therefore reads a row that is 160px wider than the
    // one on screen, and a cell that spans the station passes the floor and is still clamped to 0.
    //
    // Measured 2026-08-16 in the running app: a single pane in a 999px space with the rail open was
    // 827px wide — 999 minus 160 of rail minus the 12 of inset pair.
    onScreen(120, 600, { railWidthPx: 60 });
    // 120 minus 60 of rail leaves 60 for the row. Two cells of 30 against an inset pair of 8 have
    // 22 of interior each, so this stands.
    await expect(execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {}))
      .resolves.toMatchObject({ ok: true });

    useSessions.setState({ workspaces: [workspace()], activeId: "wsp-aaaaaa" });
    onScreen(76, 600, { railWidthPx: 60 });
    // 76 minus 60 leaves 16, so two cells of 8 have nothing left. Without the rail in the
    // arithmetic this reads as two cells of 38 and goes through.
    await expect(execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {}))
      .resolves.toMatchObject({ ok: false, code: "TOO_SMALL" });
  });

  it("nothing on screen means the split goes through — the floor is a measurement, not a guess", async () => {
    // Headless and before the first paint there is nothing to measure. Refusing on an absent
    // measurement would turn every split in a test or a fresh window into a refusal.
    document.body.innerHTML = "";
    const result = await execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {});
    expect(result).toMatchObject({ ok: true });
  });
});
