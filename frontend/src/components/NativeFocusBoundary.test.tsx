// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeFocusBoundary } from "./GroupArea";
import {
  __resetNativeDecorationsForTest,
  nativeDecorationFacts,
} from "../lib/nativeDecorations";
import { useSettings } from "../state/settings";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

describe("NativeFocusBoundary geometry projection", () => {
  let host: HTMLDivElement;
  let rect: DOMRect;

  beforeEach(() => {
    __resetNativeDecorationsForTest();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    host = document.createElement("div");
    document.body.appendChild(host);
    rect = {
      x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 140,
      width: 200, height: 120, toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("pane-focus-boundary")
          ? rect
          : ({
              x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0,
              width: 0, height: 0, toJSON: () => ({}),
            } as DOMRect);
      },
    );
    useSettings.setState({ focusIndicator: "outline" });
  });

  afterEach(() => {
    __resetNativeDecorationsForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("reprojects a position-only geometry commit before paint", async () => {
    const root = createRoot(host);
    const render = (left: string) => (
      <NativeFocusBoundary
        owner="focus/wsp-a/spc-a"
        node="layout/focus-boundary/pan-a"
        trackRef={() => {}}
        active
        style={{ left }}
      />
    );

    act(() => root.render(render("10%")));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const first = nativeDecorationFacts().decorations[0]?.path;
    expect(first).toContain("10.5");

    // Position changes while width and height remain identical. ResizeObserver does not report
    // this event; the React geometry commit itself must project the new final panel rectangle.
    rect = {
      ...rect, x: 40, left: 40, right: 240,
    } as DOMRect;
    act(() => root.render(render("40%")));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const moved = nativeDecorationFacts().decorations[0]?.path;
    expect(moved).toContain("40.5");
    expect(moved).not.toBe(first);
    act(() => root.unmount());
  });
});
