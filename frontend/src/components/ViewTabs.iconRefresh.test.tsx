// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no ResizeObserver, and the tab strip observes its own overflow. Supplying it keeps the
// failure about this file rather than about the environment.
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

// jsdom elements have no scrollTo, and the strip scrolls the active tab into view.
if (!("scrollTo" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollTo", { value: () => {}, writable: true });
}
import { ViewTabs } from "./ViewTabs";
import { useViewRegistry } from "../plugins/viewRegistry";
import type { Pane } from "../state/sessions";

// A tab bar that rendered before its plugin registered keeps the fallback glyph.
//
// Measured on the running build 2026-08-16: two panes held the same terminal view. The right one
// drew `>_`, the left one drew the generic plugin glyph, and `pane.list` answered `manifest` / `>_`
// for both. Activating the left pane — which re-rendered it — corrected the glyph, so the reading
// was right and the pixel was stale.
//
// `renderTabIcon` reads the view registry outside a selector, so the component subscribes to nothing
// there. The registry increments `version` on every register for exactly this — a consumer that does
// not read it is not told.
const PANE: Pane = {
  id: "pan-a",
  activeTabId: "tab-a",
  tabs: [{ id: "tab-a", kind: "plugin", title: "T", pluginId: "plg-a", view: "content" }],
};

const VIEW = {
  id: "content",
  title: { en: "T", ko: "T" },
  icon: ">_",
  surfaces: ["tab" as const],
  transparent: false,
  nativeSurface: false,
  decoration: false,
};

describe("a tab bar and the view registry", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const drawn = () => host.querySelector("[data-tab-icon]")?.getAttribute("data-tab-icon");

  it("draws the manifest glyph as soon as the view registers, without another render from outside", () => {
    act(() => {
      root.render(<ViewTabs projectId="wsp-h6jdzb" group={PANE} onTabPointerDown={() => {}} />);
    });
    // Oracle liveness — a bar that already drew the manifest glyph would prove nothing below.
    expect(drawn()).toBe("fallback");

    act(() => {
      restores: "none" as const,
      useViewRegistry.getState().register("plg-a", VIEW, { restores: "none" as const, mount: () => {} });
    });

    expect(drawn()).toBe("manifest");
  });
});
