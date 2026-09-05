// @vitest-environment jsdom
// An overlay registers once, with what it covers.
//
// The menu measures itself into the viewport before paint. Registering before that measurement and
// again after it puts two edges on the overlay state, and every pane parks, comes back and parks
// again between them — the capture that stands in for a surface is then taken while the surface is
// off (measured 2026-09-04: every unfocused pane showed a picture with nothing in it).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgramMenu } from "./ProgramMenu";
import { useUi } from "../state/ui";
import { useProgramRegistry } from "../plugins/programRegistry";

let host: HTMLDivElement;
let root: Root;
const pushed: Array<unknown> = [];

beforeEach(() => {
  pushed.length = 0;
  useUi.setState({ overlayCount: 0, nativeOverlayCount: 0, nativeOverlayAreas: [] });
  const push = useUi.getState().pushOverlay;
  useUi.setState({
    pushOverlay: (nativeOccludes?: boolean, area?: unknown) => {
      pushed.push(area ?? null);
      push(nativeOccludes, area as never);
    },
  });
  useProgramRegistry.setState({
    version: 1,
    programs: { "terminal-vision": { decl: { title: { en: "Vision", ko: "Vision" } } } },
    order: ["terminal-vision"],
  } as never);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the program menu as an overlay", () => {
  it("registers one overlay, and it states what the menu covers", () => {
    act(() => {
      root.render(
        <ProgramMenu pos={{ left: 100, top: 50 }} onPick={vi.fn()} onClose={vi.fn()} />,
      );
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).not.toBeNull();
    expect(useUi.getState().nativeOverlayAreas).toHaveLength(1);
  });

  // A cover is what is on screen. The menu reserved a submenu's width beside its body from the
  // first frame, whether a submenu existed or not, and a pane to the right whose surface the body
  // never touched stepped aside for it — measured 2026-09-05, a + on one card flashed the card
  // beside it.
  it("covers the body alone while no submenu is open, and the submenu once one is", () => {
    const widths: Record<string, number> = { "space-tab-menu": 130, "space-tab-submenu": 140 };
    const widthOf = (el: HTMLElement) => widths[[...el.classList].find((c) => c in widths) ?? ""] ?? 0;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return widthOf(this); } });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return widthOf(this) ? 38 : 0; } });
    HTMLElement.prototype.getBoundingClientRect = function () {
      const w = widthOf(this); const left = this.classList.contains("space-tab-submenu") ? 230 : 100;
      return { left, top: 50, right: left + w, bottom: 88, width: w, height: 38, x: left, y: 50, toJSON() {} } as DOMRect;
    };
    useProgramRegistry.setState({
      version: 2,
      programs: {
        "terminal-vision": { decl: { title: { en: "Vision", ko: "Vision" } } },
        "browser": { decl: { title: { en: "Browser", ko: "Browser" }, path: { en: "Web", ko: "Web" } } },
      },
      order: ["terminal-vision", "browser"],
    } as never);
    act(() => {
      root.render(
        <ProgramMenu pos={{ left: 100, top: 50 }} onPick={vi.fn()} onClose={vi.fn()} />,
      );
    });
    expect(useUi.getState().nativeOverlayAreas).toEqual([{ left: 100, top: 50, right: 230, bottom: 88 }]);

    act(() => {
      document.querySelector<HTMLElement>('[data-node="menu/category/Web"]')!.click();
    });
    expect(useUi.getState().nativeOverlayAreas).toEqual([{ left: 100, top: 50, right: 370, bottom: 88 }]);
  });

  // The menu is its pane's: it opens inside the pane's box, so a neighbour whose surface it never
  // needs is never put through the swap. Opened at the + and 130 wide, it ran 12px past its pane
  // into the card beside it (measured 2026-09-05).
  it("keeps its body inside the pane it belongs to", () => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.classList.contains("space-tab-menu") ? 130 : 0; } });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return this.classList.contains("space-tab-menu") ? 38 : 0; } });
    act(() => {
      root.render(
        <ProgramMenu pos={{ left: 100, top: 50 }} within={{ left: 0, right: 220 }} onPick={vi.fn()} onClose={vi.fn()} />,
      );
    });
    expect(useUi.getState().nativeOverlayAreas).toEqual([{ left: 90, top: 50, right: 220, bottom: 88 }]);
    expect((document.querySelector(".space-tab-menu") as HTMLElement).style.left).toBe("90px");
  });
});
