// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailLinkOverlay } from "./RailLinkOverlay";
import type { RailRelationState } from "../lib/railArrangement";
import { useSettings } from "../state/settings";
import {
  __resetNativeDecorationsForTest,
  nativeDecorationFacts,
} from "../lib/nativeDecorations";

vi.mock("../state/theme", () => ({
  useTheme: (select: (state: unknown) => unknown) =>
    select({
      colors: { acc: "#5aa2ff" },
      spec: { relation: { radius: 12, strokeWidth: 1.5, stroke: "var(--acc)" } },
    }),
}));
vi.mock("../i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../i18n")>()),
  useT: () => () => "LINKED",
}));

let observed: ((entries: Array<{ contentRect: DOMRect }>) => void) | undefined;
class ResizeObserverMock {
  constructor(callback: typeof observed) {
    observed = callback;
  }
  observe() {}
  disconnect() {}
}

let hostSize = { width: 1200, height: 800 };

const relation = (
  over: Partial<RailRelationState> = {},
): RailRelationState => ({
  boundTabId: "tab-bbbbbb",
  boundPaneId: "pan-bbbbbb",
  source: "focus",
  relationId: "rail-relation/spc-aaaaaa/pan-bbbbbb/tab-bbbbbb",
  placement: "flow",
  connected: true,
  side: "right",
  borderMode: "union",
  pathCount: 1,
  ...over,
});

describe("RailLinkOverlay — live grid tracking", () => {
  beforeEach(() => {
    __resetNativeDecorationsForTest();
    observed = undefined;
    hostSize = { width: 1200, height: 800 };
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({
        x: 0, y: 0, left: 0, top: 0, right: hostSize.width,
        bottom: hostSize.height, width: hostSize.width, height: hostSize.height,
        toJSON: () => ({}),
      }),
    );
  });

  afterEach(() => {
    __resetNativeDecorationsForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("keeps the relation state tied to the shared layout boxes without drawing a second card", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (width: number) => (
      <RailLinkOverlay
        contentId="spc-aaaaaa"
        relation={relation()}
        railWidth={300}
        paneInset={0}
        railStation={50}
        targetRect={{ left: 50, top: 0, width, height: 50 }}
      />
    );

    act(() => root.render(render(25)));
    const overlay = host.querySelector<HTMLElement>(".rail-link-overlay")!;
    expect(overlay.dataset).toMatchObject({
      node: "relation/rail/spc-aaaaaa",
      boundTab: "tab-bbbbbb",
      boundPane: "pan-bbbbbb",
      connected: "true",
    });
    expect(host.querySelectorAll("path")).toHaveLength(0);

    act(() => root.render(render(40)));
    expect(host.querySelectorAll("path")).toHaveLength(0);

    hostSize = { width: 1000, height: 700 };
    act(() => observed?.([{ contentRect: {
      ...hostSize, x: 0, y: 0, left: 0, top: 0,
      right: 1000, bottom: 700, toJSON: () => ({}),
    } as DOMRect }]));
    expect(host.querySelectorAll("path")).toHaveLength(0);

    act(() => root.unmount());
  });

  it("draws no path when there is no relation, leaving only the none/0 public root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(
      <RailLinkOverlay
        contentId="spc-aaaaaa"
        relation={relation({
          boundTabId: null,
          boundPaneId: null,
          relationId: "rail-relation/spc-aaaaaa/none",
          connected: false,
          side: "detached",
          borderMode: "none",
          pathCount: 0,
        })}
        railWidth={300} paneInset={0} railStation={0}
        targetRect={null}
      />,
    ));
    const overlay = host.querySelector<HTMLElement>(".rail-link-overlay");
    expect(overlay?.dataset).toMatchObject({ borderMode: "none", pathCount: "0" });
    expect(overlay?.querySelector("svg")).toBeNull();
    act(() => root.unmount());
  });

  it("does not publish a duplicate union perimeter to the native plane", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(
      <RailLinkOverlay
        contentId="spc-aaaaaa"
        relation={relation()}
        railWidth={300}
        paneInset={0}
        railStation={50}
        targetRect={{ left: 50, top: 0, width: 25, height: 50 }}
        nativeVisible
      />,
    ));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const native = nativeDecorationFacts().decorations;
    expect(native).toHaveLength(0);
    act(() => root.unmount());
  });

// Nested on purpose — the outer describe's beforeEach (ResizeObserver and rect mocks) applies here.
describe("projected-adjacency marking", () => {
  const renderProps = (projected: boolean) => (
    <RailLinkOverlay
      contentId="spc-aaaaaa"
      relation={relation()}
      railWidth={300}
      paneInset={0}
      railStation={50}
      targetRect={{ left: 50, top: 0, width: 25, height: 50 }}
      projected={projected}
    />
  );

  it("edge (default): projected=true still exposes projection state without a second perimeter", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(renderProps(true)));
    const overlay = host.querySelector<HTMLElement>(".rail-link-overlay")!;
    expect(overlay.dataset.projected).toBe("true");
    expect(host.querySelector(".rail-link-edge")).toBeNull();
    expect(host.querySelector(".rail-link-rest")).toBeNull();
    expect(host.querySelector(".rail-link-seam")).toBeNull();
    act(() => root.unmount());
  });

  it("seam option: draws the inner shared edge dashed (a supported choice)", () => {
    act(() => useSettings.setState({ railSeamStyle: "seam" }));
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const mounted = createRoot(host);
      root = mounted;
      act(() => mounted.render(renderProps(true)));
      expect(host.querySelector(".rail-link-seam")).not.toBeNull();
      expect(host.querySelector(".rail-link-edge")).toBeNull();
    } finally {
      if (root) act(() => root!.unmount());
      act(() => useSettings.setState({ railSeamStyle: "edge" }));
    }
  });

  it("natural adjacency (projected=false) has no marking at all", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(renderProps(false)));
    expect(host.querySelector(".rail-link-seam")).toBeNull();
    expect(host.querySelector(".rail-link-edge")).toBeNull();
    const overlay = host.querySelector<HTMLElement>(".rail-link-overlay")!;
    expect(overlay.dataset.projected).toBeUndefined();
    act(() => root.unmount());
  });
});
});
