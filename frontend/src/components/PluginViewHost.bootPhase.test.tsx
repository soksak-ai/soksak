// Three-phase contract for an unregistered view — "empty" and "about to be filled" are different
// facts (user decision 2026-07-27: the user must be able to tell which of the two it is).
//
// RED evidence: on a boot where restore runs before the plugin host (restore threshold 300ms), an
// unregistered view rendered as "no plugin view" before activation finished — a slot about to be
// filled reported as absent.
// Contract: unregistered before ready = plugin-loading, unregistered after ready = plugin-empty
// (genuine absence).
import { afterEach, describe, it, expect, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { PluginViewHost } from "./PluginViewHost";
import { useViewRegistry } from "../plugins/viewRegistry";
import { useBootPhase } from "../state/bootPhase";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function mountHost(host: HTMLElement): Root {
  const root = createRoot(host);
  act(() => {
    root.render(
      <PluginViewHost
        viewKey="nope.canvas"
        projectId="p1"
        root={null}
        region="center"
      />,
    );
  });
  return root;
}

describe("PluginViewHost — the three boot phases of an unregistered view", () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, version: 0, badges: {} });
    useBootPhase.setState({ phase: "ready" });
    root = null;
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    host.remove();
  });

  it("an unregistered view during boot (restoring/activating) is loading, not absent", () => {
    for (const phase of ["restoring", "activating"] as const) {
      act(() => useBootPhase.setState({ phase }));
      root = mountHost(host);
      expect(host.querySelector(".plugin-loading"), phase).not.toBeNull();
      expect(host.querySelector(".plugin-empty"), phase).toBeNull();
      act(() => root!.unmount());
      root = null;
    }
  });

  it("only an unregistered view after ready is absent (plugin-empty)", () => {
    root = mountHost(host);
    expect(host.querySelector(".plugin-empty")).not.toBeNull();
    expect(host.querySelector(".plugin-loading")).toBeNull();
  });

  it("on the transition to ready the loading marker resolves in place to absent or registered", () => {
    act(() => useBootPhase.setState({ phase: "activating" }));
    root = mountHost(host);
    expect(host.querySelector(".plugin-loading")).not.toBeNull();
    act(() => useBootPhase.setState({ phase: "ready" }));
    expect(host.querySelector(".plugin-loading")).toBeNull();
    expect(host.querySelector(".plugin-empty")).not.toBeNull();
  });

});
