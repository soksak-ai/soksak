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
});
