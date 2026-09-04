// layout.verify subtracts the declared arrangement from the measured DOM, and a verifier that gets the
// subtraction wrong reports GREEN for a broken screen. So the subtraction is checked here.
//
// jsdom has no layout engine — every rect it reports is zero — so the measurements are stubbed. That
// bounds what this file can prove: the arithmetic, the tolerance, and the two roll-call lists. Whether
// the arithmetic matches the .pane rule in App.css is a fact only the running app has, and
// layout.verify is the command that reads it there.
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
import { splitLeaf } from "../state/splitTree";

const HOST = { left: 12, top: 30, width: 1000, height: 800 };
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
    root: "/tmp/verify",
    regionOpen: { left: false, rail: false, right: false },
    railPlacement: { mode: "flow" },
    sidebarLayouts: { left: initialSidebarLayout([]), rail: initialSidebarLayout([]), right: initialSidebarLayout([]) },
    spaces: [
      {
        id: "spc-aaaaaa",
        title: "1",
        activePaneId: "pan-aaaaaa",
        layout: {
          type: "split",
          id: "spl-aaaaaa",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [splitLeaf(pane("pan-aaaaaa")), splitLeaf(pane("pan-bbbbbb"))],
        },
      },
    ],
    activeSpaceId: "spc-aaaaaa",
  };
}

/** The rect the .pane rule produces for a cell declared at these percentages. */
function laidOut(leftPct: number, widthPct: number, railDx = 0, railDw = 0) {
  return {
    left: HOST.left + (HOST.width * leftPct) / 100 + railDx + INSET,
    top: HOST.top + INSET,
    width: (HOST.width * widthPct) / 100 + railDw - INSET * 2,
    height: HOST.height - INSET * 2,
  };
}

function measure(el: HTMLElement, rect: { left: number; top: number; width: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    }) as DOMRect;
}

/** Builds the space element and its panes, and returns them by pane id. */
function plant(
  panes: Array<{ id: string; rect: { left: number; top: number; width: number; height: number }; vars?: Record<string, string> }>,
): Map<string, HTMLElement> {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.dataset.node = "layout/space/spc-aaaaaa";
  measure(host, HOST);
  document.body.append(host);

  const vars = new Map<HTMLElement, Record<string, string>>();
  vars.set(host, { "--pane-inset": `${INSET}px` });

  const built = new Map<string, HTMLElement>();
  for (const p of panes) {
    const el = document.createElement("div");
    el.dataset.node = `layout/pane/${p.id}`;
    el.dataset.pane = p.id;
    measure(el, p.rect);
    vars.set(el, { "--pane-inset": `${INSET}px`, ...(p.vars ?? {}) });
    host.append(el);
    built.set(p.id, el);
  }

  // jsdom does not resolve custom properties, so the declared inputs are served directly.
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    ((el: Element) =>
      ({
        getPropertyValue: (name: string) => vars.get(el as HTMLElement)?.[name] ?? "",
      })) as typeof window.getComputedStyle,
  );
  return built;
}

registerCatalog();

beforeEach(() => {
  vi.restoreAllMocks();
  useSessions.setState({ workspaces: [workspace()], activeId: "wsp-aaaaaa" });
});

describe("layout.verify", () => {
  it("a settled screen that matches the arrangement reports a difference of 0", async () => {
    plant([
      { id: "pan-aaaaaa", rect: laidOut(0, 50) },
      { id: "pan-bbbbbb", rect: laidOut(50, 50) },
    ]);
    const result = await execute("layout.verify", {}, {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      worst: number;
      tolerance: number;
      settled: boolean;
      inFlight: string[];
      missing: string[];
      unexpected: string[];
      panes: Array<{ id: string; delta: Record<string, number> }>;
    };
    expect(data.worst).toBe(0);
    expect(data.worst).toBeLessThanOrEqual(data.tolerance);
    expect(data.settled, "nothing is in flight, so the numbers describe the layout").toBe(true);
    expect(data.inFlight).toEqual([]);
    expect(data.missing).toEqual([]);
    expect(data.unexpected).toEqual([]);
    expect(data.panes.map((p) => p.id)).toEqual(["pan-aaaaaa", "pan-bbbbbb"]);
  });

  it("a pane rendered three pixels off is reported as three pixels off", async () => {
    const off = laidOut(50, 50);
    plant([
      { id: "pan-aaaaaa", rect: laidOut(0, 50) },
      { id: "pan-bbbbbb", rect: { ...off, left: off.left + 3 } },
    ]);
    const data = (await execute("layout.verify", {}, {})).data as {
      worst: number;
      tolerance: number;
      panes: Array<{ id: string; worst: number; delta: { left: number } }>;
    };
    expect(data.worst).toBeCloseTo(3, 9);
    expect(data.worst).toBeGreaterThan(data.tolerance);
    expect(data.panes.find((p) => p.id === "pan-bbbbbb")!.delta.left).toBeCloseTo(3, 9);
    expect(data.panes.find((p) => p.id === "pan-aaaaaa")!.worst).toBe(0);
  });

  it("the rail offset a pane carries is part of where it is expected to be", async () => {
    // The rail shifts panes sideways without changing the declared percentage. A verifier that ignores
    // the shift calls every rail-open layout broken.
    plant([
      { id: "pan-aaaaaa", rect: laidOut(0, 50, 0, -120), vars: { "--rail-dw": "-120px" } },
      { id: "pan-bbbbbb", rect: laidOut(50, 50, -120, 120), vars: { "--rail-dx": "-120px", "--rail-dw": "120px" } },
    ]);
    const data = (await execute("layout.verify", {}, {})).data as { worst: number };
    expect(data.worst).toBe(0);
  });

  it("a pane the arrangement names but the screen does not draw comes back as missing", async () => {
    plant([{ id: "pan-aaaaaa", rect: laidOut(0, 50) }]);
    const data = (await execute("layout.verify", {}, {})).data as { missing: string[]; unexpected: string[] };
    expect(data.missing).toEqual(["pan-bbbbbb"]);
    expect(data.unexpected).toEqual([]);
  });

  it("a pane on screen that the arrangement does not name comes back as unexpected", async () => {
    plant([
      { id: "pan-aaaaaa", rect: laidOut(0, 50) },
      { id: "pan-bbbbbb", rect: laidOut(50, 50) },
      { id: "pan-cccccc", rect: laidOut(50, 50) },
    ]);
    const data = (await execute("layout.verify", {}, {})).data as { missing: string[]; unexpected: string[] };
    expect(data.missing).toEqual([]);
    expect(data.unexpected).toEqual(["pan-cccccc"]);
  });

  it("a DOM that does not hold the arrangement answers settled false", async () => {
    // The numbers are still reported — they are what a reader needs to see the lag — but the answer
    // states that they describe a DOM built from a different tree, so nobody reads them as a verdict.
    plant([{ id: "pan-aaaaaa", rect: laidOut(0, 50) }]);
    const data = (await execute("layout.verify", {}, {})).data as {
      settled: boolean;
      missing: string[];
    };
    expect(data.settled).toBe(false);
    expect(data.missing).toEqual(["pan-bbbbbb"]);
  });

  it("no space element on screen is NOT_EXPOSED, not a difference of 0", async () => {
    document.body.innerHTML = "";
    const result = await execute("layout.verify", {}, {});
    expect(result).toMatchObject({ ok: false, code: "NOT_EXPOSED" });
  });
});
