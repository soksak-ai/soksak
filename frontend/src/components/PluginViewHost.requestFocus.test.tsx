// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginViewHost } from "./PluginViewHost";
import { useViewRegistry } from "../plugins/viewRegistry";
import { useSessions } from "../state/sessions";
import type { PluginViewContext } from "../plugins/viewRegistry";

// A view reports that it was interacted with, and the core moves the focus.
//
// A view drawn on a native surface receives its own clicks and the document never sees them: a click
// inside a browser page left the focused pane where it was, measured on the running build
// 2026-08-17, while a click on that pane's tab moved it. The view has no way to say what happened,
// so the fact had nowhere to go.
//
// What focus means stays the core's: which pane, which tab, what the lighting follows. The view
// states the fact and nothing more.
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

const PLUGIN = "plg-a";
const VIEW_KEY = `${PLUGIN}.content`;

const decl = {
  id: "content",
  title: { en: "T", ko: "T" },
  icon: "|",
  placements: ["center" as const],
  defaultPlacement: "center" as const,
  transparent: false,
  nativeSurface: false,
  decoration: false,
};

describe("a view that reports it was interacted with", () => {
  let host: HTMLDivElement;
  let root: Root;
  let context: PluginViewContext | null = null;

  beforeEach(() => {
    context = null;
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
    useViewRegistry.getState().register(PLUGIN, decl, {
      mount: (_element, ctx) => {
        context = ctx;
      },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("makes its pane the focused one and itself that pane's active tab", () => {
    // Nothing here is conditional. A test that returns early when its fixture is not what it
    // expected asserts nothing and reads as a pass — the store below is what answers.
    act(() => {
      root.render(
        <PluginViewHost
          viewKey={VIEW_KEY}
          projectId="wsp-a1b2c3"
          root={null}
          region="center"
          paneId="pan-a1b2c3"
          viewId="tab-a1b2c3"
        />,
      );
    });

    expect(context, "the view never mounted, so nothing could report anything").not.toBeNull();
    expect(typeof context!.requestFocus).toBe("function");

    const calls: string[] = [];
    useSessions.setState({
      setActiveGroup: ((_p: string, g: string) => {
        calls.push(`pane:${g}`);
        return { ok: true as const };
      }) as never,
      setActiveView: ((_p: string, v: string) => {
        calls.push(`tab:${v}`);
        return { ok: true as const };
      }) as never,
    });

    act(() => context!.requestFocus());

    expect(calls).toEqual(["pane:pan-a1b2c3", "tab:tab-a1b2c3"]);
  });
});
