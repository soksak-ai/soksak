// @vitest-environment jsdom
// A pane with no view states what actually happened to the plugin.
//
// It said "the plugin is disabled or removed" whenever the view was not registered — one sentence
// for every reason a view can be absent. Measured 2026-08-19: after the manifest contract changed,
// three installed plugins were refused by name and every pane in the window read that sentence.
// Nothing was disabled and nothing was removed. The reason existed — `plugin.list` answered
// `rejected[]` with the refused keys — and the screen said something else.
//
// A sentence that is not true about the state it describes sends a person to the wrong place. Three
// states, three sentences, and the refusal comes with its own reason.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { PluginViewHost } from "./PluginViewHost";
import { usePlugins } from "../state/plugins";
import { useViewRegistry } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";
import { collectExposed, registerDomCatalog } from "../commands/catalogDom";
import { catalogJson, execute, unregister } from "../commands/registry";

describe("what a pane says when its view is not there", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
    usePlugins.setState({ plugins: {}, rejected: [] });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const draw = () =>
    act(() => {
      root.render(
        <PluginViewHost
          viewKey="soksak-plugin-file-tree.tree"
          projectId="wsp-aaaaaa"
          root="<local-evidence>/w"
          region="rail"
          paneId="pan-aaaaaa"
        />,
      );
    });

  const said = () => host.textContent ?? "";

  it("names the manifest as refused, and says what was refused", () => {
    usePlugins.setState({
      rejected: [
        {
          id: "soksak-plugin-file-tree",
          dir: "/home/plugins/soksak-plugin-file-tree",
          errors: ['contributes.views[0]: unknown key "placements"'],
        },
      ],
    });
    draw();
    expect(said()).toContain("placements");
    expect(said()).not.toContain("removed");
  });

  it("says the plugin is installed and off when that is what it is", () => {
    usePlugins.setState({
      plugins: {
        "soksak-plugin-file-tree": {
          id: "soksak-plugin-file-tree",
          status: "disabled",
        } as never,
      },
    });
    draw();
    expect(said()).not.toContain("removed");
  });

  it("says the plugin is not installed when nothing knows it", () => {
    draw();
    expect(said().length).toBeGreaterThan(0);
  });
});

// The overlay is an exposed node. Measured 2026-08-26 on the running app: a disabled plugin's pane
// showed the sentence, and ui.tree reported 0 nodes for that pane — the overlay had no data-node,
// so the state on screen was not readable through the address tree.
describe("the overlay is addressable under the view's address", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
    usePlugins.setState({ plugins: {}, rejected: [] });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const draw = () =>
    act(() => {
      root.render(
        <PluginViewHost
          viewKey="soksak-plugin-file-tree.tree"
          projectId="wsp-aaaaaa"
          root="<local-evidence>/w"
          region="center"
          viewId="tab-aaaaaa"
        />,
      );
    });

  const node = (name: string) => host.querySelector<HTMLElement>(`[data-node="${name}"]`);
  const addresses = () => collectExposed().map((n) => n.address);

  it("installed and off: plugin-view-placeholder with data-view-state off", () => {
    usePlugins.setState({
      plugins: {
        "soksak-plugin-file-tree": { id: "soksak-plugin-file-tree", status: "disabled" } as never,
      },
    });
    draw();
    const el = node("plugin-view-placeholder");
    expect(el?.dataset.viewState).toBe("off");
    expect(el?.dataset.viewPlugin).toBe("soksak-plugin-file-tree");
    expect(el?.dataset.viewReason).toBeUndefined();
    expect(addresses()).toContainEqual(
      expect.stringMatching(/center\/view\/soksak-plugin-file-tree\.tree\/tab\/tab-aaaaaa\/node\/plugin-view-placeholder$/),
    );
  });

  // The overlay declares the view address under data-view-overlay-addr, not data-view-addr. ui.slot
  // resolves data-view-addr, and A2 needs one element per address: the container.
  it("installed and off: the container alone holds data-view-addr; ui.slot resolves the container", async () => {
    usePlugins.setState({
      plugins: {
        "soksak-plugin-file-tree": { id: "soksak-plugin-file-tree", status: "disabled" } as never,
      },
    });
    draw();
    const viewAddr = "center/view/soksak-plugin-file-tree.tree/tab/tab-aaaaaa";
    const holders = host.querySelectorAll<HTMLElement>("[data-view-addr]");
    expect(holders).toHaveLength(1);
    expect(holders[0].classList.contains("tab-viewer")).toBe(true);
    const overlay = node("plugin-view-placeholder")!;
    expect(overlay.dataset.viewOverlayAddr).toBe(viewAddr);
    expect(overlay.dataset.viewAddr).toBeUndefined();
    Object.defineProperty(holders[0], "getBoundingClientRect", { value: () => ({ x: 20, y: 30, width: 640, height: 480 }) });
    Object.defineProperty(overlay, "getBoundingClientRect", { value: () => ({ x: 1, y: 2, width: 3, height: 4 }) });
    registerDomCatalog();
    try {
      const slot = await execute("ui.slot", { address: viewAddr }, {});
      expect(slot).toMatchObject({ ok: true, data: { rect: { x: 20, y: 30, w: 640, h: 480 } } });
    } finally {
      for (const { name } of catalogJson()) unregister(name);
    }
  });

  it("refused: data-view-state refused and data-view-reason with the errors joined", () => {
    usePlugins.setState({
      rejected: [
        {
          id: "soksak-plugin-file-tree",
          dir: "/home/plugins/soksak-plugin-file-tree",
          errors: ['contributes.views[0]: unknown key "placements"', "permissions: empty"],
        },
      ],
    });
    draw();
    const el = node("plugin-view-placeholder");
    expect(el?.dataset.viewState).toBe("refused");
    expect(el?.dataset.viewPlugin).toBe("soksak-plugin-file-tree");
    expect(el?.dataset.viewReason).toBe('contributes.views[0]: unknown key "placements"; permissions: empty');
  });

  it("not installed: data-view-state absent", () => {
    draw();
    expect(node("plugin-view-placeholder")?.dataset.viewState).toBe("absent");
  });

  it("mount error: plugin-view-error with data-view-error", () => {
    const decl = { id: "tree", title: { en: "Tree" }, surfaces: ["tab"] } as unknown as ContributedView;
    const provider = {
      mount() { throw new Error("entry threw at mount"); },
      unmount() {},
    };
    act(() => {
      useViewRegistry.getState().register("soksak-plugin-file-tree", decl, provider as never);
    });
    draw();
    const el = node("plugin-view-error");
    expect(el?.dataset.viewPlugin).toBe("soksak-plugin-file-tree");
    expect(el?.dataset.viewError).toContain("entry threw at mount");
    expect(node("plugin-view-placeholder")).toBeNull();
    expect(addresses()).toContainEqual(
      expect.stringMatching(/center\/view\/soksak-plugin-file-tree\.tree\/tab\/tab-aaaaaa\/node\/plugin-view-error$/),
    );
  });
});
