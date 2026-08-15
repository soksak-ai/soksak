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
    root: "<local-evidence>/floor",
    sidebarOpen: false,
    leftRailPlacement: { mode: "flow" },
    rightOpen: false,
    rightView: null,
    leftLayout: initialSidebarLayout([]),
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

/** Puts the space box on screen at the given size, with the inset the .pane rule consumes. */
function onScreen(width: number, height: number): void {
  document.body.innerHTML = "";
  const el = document.createElement("div");
  el.dataset.node = "layout/space/spc-aaaaaa";
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.append(el);
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    ((): CSSStyleDeclaration =>
      ({ getPropertyValue: (name: string) => (name === "--pane-inset" ? `${INSET}px` : "") }) as CSSStyleDeclaration),
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

  it("nothing on screen means the split goes through — the floor is a measurement, not a guess", async () => {
    // Headless and before the first paint there is nothing to measure. Refusing on an absent
    // measurement would turn every split in a test or a fresh window into a refusal.
    document.body.innerHTML = "";
    const result = await execute("pane.split", { pane: "pan-aaaaaa", side: "right", mountTimeoutMs: 0 }, {});
    expect(result).toMatchObject({ ok: true });
  });
});
