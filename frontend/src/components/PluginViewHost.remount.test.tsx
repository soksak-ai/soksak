// PluginViewHost container generation isolation — a structural remount (unregister then re-register, e.g.
// plugin.reload) must always issue a new container DOM node. attachShadow is irreversible, so a reused node
// hands the previous generation's shadow root (and the residue left by an incomplete provider.unmount) to
// the next mount — generation isolation blocks that inflow structurally.
import { describe, it, expect, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { PluginViewHost } from "./PluginViewHost";
import { useViewRegistry } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const DECL = {
  id: "canvas",
  title: { en: "T" },
  icon: "▤",
  placements: ["content"],
  defaultPlacement: "content",
  transparent: false,
  nativeSurface: false,
} as unknown as ContributedView;

function resetRegistry() {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
}

describe("PluginViewHost — container generation isolation", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetRegistry();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("gives the provider a new container with no shadow root after re-registration (plugin.reload)", () => {
    const containers: HTMLElement[] = [];
    const shadowAtMount: boolean[] = [];
    const provider = {
      mount(el: HTMLElement) {
        containers.push(el);
        shadowAtMount.push(el.shadowRoot != null);
        // Usage pattern of a real view plugin — the shadow root stays on the node irreversibly.
        if (!el.shadowRoot) el.attachShadow({ mode: "open" });
      },
      unmount() {},
    };

    let unregister: () => void;
    act(() => {
      unregister = useViewRegistry
        .getState()
        .register("test-plugin", DECL, provider);
    });
    act(() => {
      root = createRoot(host);
      root.render(
        <PluginViewHost
          viewKey="test-plugin.canvas"
          projectId="p1"
          root={null}
          region="content"
        />,
      );
    });
    expect(containers.length).toBe(1);
    expect(containers[0].shadowRoot).not.toBeNull();

    // plugin.reload equivalent: unregister, then re-register. The host remounts.
    act(() => {
      unregister();
    });
    act(() => {
      useViewRegistry.getState().register("test-plugin", DECL, provider);
    });

    expect(containers.length).toBe(2);
    // Contract: a new generation is a new DOM node — at mount entry there must be no shadow root from the previous generation.
    expect(containers[1]).not.toBe(containers[0]);
    expect(shadowAtMount).toEqual([false, false]);

    act(() => {
      root.unmount();
    });
  });
});
